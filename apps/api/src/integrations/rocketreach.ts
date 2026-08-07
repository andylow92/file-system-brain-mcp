import {
  redactSecrets,
  ROCKETREACH_UNLIMITED_CREDITS,
  type RocketReachAccountStatus,
  type RocketReachCandidate,
  type RocketReachContact,
  type RocketReachCreditBalance,
  type RocketReachSearchCriteria,
} from '@repo/shared';

/**
 * Minimal server-side client for the RocketReach v2 API.
 *
 * Design constraints (see issue #97):
 * - **Fail closed:** constructing without a key throws; the route layer must
 *   check `enabled` + a stored key before it ever gets here.
 * - **Secret hygiene:** the key is only ever sent as the `Api-Key` header,
 *   never in a URL or query string, and any error text is run through
 *   `redactSecrets` so the key cannot leak into logs, notes, or tool responses.
 * - **Testable:** `fetchImpl` is injectable so tests never touch the network.
 *
 * The response mapping is intentionally lenient — RocketReach returns snake_case
 * fields and has evolved its payloads over time, so we read the fields we need
 * defensively and normalize to the shared, camelCase shapes.
 */

const DEFAULT_BASE_URL = 'https://api.rocketreach.co/v2';
const NON_JSON_ERROR_DETAIL_LIMIT = 500;

export class RocketReachError extends Error {
  constructor(
    message: string,
    public code: string = 'rocketreach_error',
    public status?: number,
  ) {
    super(message);
    this.name = 'RocketReachError';
  }
}

export interface RocketReachClient {
  getAccountStatus(): Promise<RocketReachAccountStatus>;
  search(criteria: RocketReachSearchCriteria, limit: number): Promise<RocketReachCandidate[]>;
  lookup(ids: string[]): Promise<RocketReachContact[]>;
}

export interface RocketReachClientOptions {
  apiKey: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Override the API base URL (tests / self-hosted proxies). */
  baseUrl?: string;
}

type Json = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function createRocketReachClient(options: RocketReachClientOptions): RocketReachClient {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    // Fail closed — never construct a live client without a key.
    throw new RocketReachError('RocketReach API key is not configured', 'setup_required');
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

  /** Redact the key from anything before it becomes an error the caller sees. */
  const clean = (text: string): string => redactSecrets(text, [apiKey]);

  async function request(pathname: string, init?: RequestInit): Promise<Json> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${pathname}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          // Key travels only in this header, never the URL.
          'Api-Key': apiKey,
          ...(init?.headers ?? {}),
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'network error';
      throw new RocketReachError(`RocketReach request failed: ${clean(message)}`, 'network_error');
    }

    const text = await response.text();
    let payload: Json = {};
    let nonJsonErrorDetail: string | undefined;
    if (text) {
      try {
        payload = JSON.parse(text) as Json;
      } catch {
        nonJsonErrorDetail = text.slice(0, NON_JSON_ERROR_DETAIL_LIMIT);
      }
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new RocketReachError(
          'RocketReach rejected the API key (unauthorized)',
          'invalid_key',
          response.status,
        );
      }
      if (response.status === 429) {
        throw new RocketReachError('RocketReach rate limit exceeded', 'rate_limited', 429);
      }
      const detail =
        asString(payload.message) ??
        asString(payload.detail) ??
        (nonJsonErrorDetail
          ? `HTTP ${response.status} from RocketReach: ${nonJsonErrorDetail}`
          : `HTTP ${response.status} from RocketReach`);
      throw new RocketReachError(
        `RocketReach error: ${clean(detail)}`,
        'rocketreach_error',
        response.status,
      );
    }

    return payload;
  }

  function mapProfile(raw: Json): RocketReachCandidate {
    const id = asString(raw.id) ?? String(raw.id ?? '');
    return {
      id,
      name: asString(raw.name) ?? asString(raw.full_name) ?? 'Unknown',
      title: asString(raw.current_title) ?? asString(raw.title),
      company: asString(raw.current_employer) ?? asString(raw.employer) ?? asString(raw.company),
      location: asString(raw.location) ?? asString(raw.region),
      linkedinUrl: asString(raw.linkedin_url),
      profileUrl: asString(raw.profile_url) ?? asString(raw.link),
      hasWorkEmail:
        asNumber(raw.emails) != null
          ? Number(raw.emails) > 0
          : Array.isArray(raw.emails)
            ? raw.emails.length > 0
            : undefined,
    };
  }

  /**
   * Remaining paid lookup credits. The live v2 account payload reports these in
   * a `credit_usage` array keyed by `credit_type` — `standard_lookup` is the one
   * `lookup()` spends, and `company_export` sits next to it with an
   * identical-looking balance, so the row must be selected by type, not position.
   *
   * `remaining` is not always a number: an uncapped allowance comes back as the
   * string `"inf"`, which would otherwise read as "no credits" — the exact
   * opposite of the truth — so it maps to the `'unlimited'` sentinel, which
   * survives both JSON and YAML (see {@link RocketReachCreditBalance}).
   *
   * The flat fields are kept as fallbacks for tiers that expose them, so
   * budgeting keeps working whichever shape an account returns.
   */
  function readLookupCredits(payload: Json): RocketReachCreditBalance | undefined {
    const usage = payload.credit_usage;
    if (Array.isArray(usage)) {
      const row = usage.find((entry) => (entry as Json)?.credit_type === 'standard_lookup') as
        Json | undefined;
      if (row) {
        if (row.remaining === 'inf' || row.allocated === 'inf') {
          return ROCKETREACH_UNLIMITED_CREDITS;
        }
        const remaining = asNumber(row.remaining);
        if (remaining != null) return remaining;
        // Some tiers report the allowance and the spend but no `remaining`.
        const allocated = asNumber(row.allocated);
        const used = asNumber(row.used);
        if (allocated != null && used != null) return Math.max(0, allocated - used);
      }
    }
    return (
      asNumber(payload.lookup_credit_balance) ??
      asNumber(payload.lookupCreditBalance) ??
      asNumber(payload.credits)
    );
  }

  async function getAccountStatus(): Promise<RocketReachAccountStatus> {
    const payload = await request('/api/account', { method: 'GET' });
    return {
      plan: asString(payload.plan) ?? asString((payload.subscription as Json)?.plan_name),
      // Free/unsubscribed accounts carry no plan name, only a lifecycle `state`
      // (e.g. `registered`). Reported separately so nobody reads it as a tier.
      state: asString(payload.state),
      lookupCreditBalance: readLookupCredits(payload),
      accountName: asString(payload.name) ?? asString(payload.email),
    };
  }

  async function search(
    criteria: RocketReachSearchCriteria,
    limit: number,
  ): Promise<RocketReachCandidate[]> {
    // RocketReach expects arrays of match terms under `query`.
    const query: Json = {};
    if (criteria.titles?.length) query.current_title = criteria.titles;
    if (criteria.companies?.length) query.current_employer = criteria.companies;
    if (criteria.regions?.length) query.location = criteria.regions;
    if (criteria.industries?.length) query.industry = criteria.industries;
    const keywords = [
      ...(criteria.keywords ?? []),
      ...(criteria.audience ? [criteria.audience] : []),
    ];
    if (keywords.length) query.keyword = keywords;

    const payload = await request('/api/search', {
      method: 'POST',
      body: JSON.stringify({ query, page: 1, page_size: Math.max(1, limit) }),
    });

    const profiles = Array.isArray(payload.profiles)
      ? (payload.profiles as Json[])
      : Array.isArray(payload.results)
        ? (payload.results as Json[])
        : [];

    return profiles.slice(0, limit).map(mapProfile);
  }

  async function lookup(ids: string[]): Promise<RocketReachContact[]> {
    const contacts: RocketReachContact[] = [];
    for (const id of ids) {
      // `id` is a RocketReach profile id, not a secret — safe in the query.
      const payload = await request(`/api/lookupProfile?id=${encodeURIComponent(id)}`, {
        method: 'GET',
      });
      const emails = Array.isArray(payload.emails)
        ? (payload.emails as unknown[])
            .map((e) =>
              typeof e === 'string'
                ? e
                : (asString((e as Json)?.email) ?? asString((e as Json)?.value)),
            )
            .filter((e): e is string => Boolean(e))
        : [];
      const phones = Array.isArray(payload.phones)
        ? (payload.phones as unknown[])
            .map((p) => (typeof p === 'string' ? p : asString((p as Json)?.number)))
            .filter((p): p is string => Boolean(p))
        : [];
      contacts.push({
        ...mapProfile(payload),
        id,
        emails,
        phones,
        status: asString(payload.status),
      });
    }
    return contacts;
  }

  return { getAccountStatus, search, lookup };
}
