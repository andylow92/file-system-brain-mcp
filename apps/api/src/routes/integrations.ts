import http from 'node:http';

import {
  buildRunRecordNote,
  DEFAULT_MAX_CANDIDATES,
  MAX_CANDIDATES_LIMIT,
  maskApiKey,
  redactSecrets,
  ROCKETREACH_INTAKE_QUESTIONS,
  type ApiResponse,
  type IntegrationState,
  type RocketReachCandidate,
  type RocketReachContact,
  type RocketReachRunRecord,
  type RocketReachSearchCriteria,
  type RocketReachStatus,
} from '@repo/shared';

import type { EventBus } from '../events/eventBus.js';
import {
  createRocketReachClient as defaultCreateClient,
  RocketReachError,
  type RocketReachClient,
  type RocketReachClientOptions,
} from '../integrations/rocketreach.js';
import type { AuditLog } from '../storage/auditLog.js';
import type { FileRepository } from '../storage/fileRepository.js';
import type { IntegrationStore } from '../storage/integrationStore.js';

export interface IntegrationRouteDependencies {
  integrationStore: IntegrationStore;
  repository: FileRepository;
  auditLog: AuditLog;
  eventBus: EventBus;
  /** Injectable so route tests never touch the network. */
  createRocketReachClient?: (options: RocketReachClientOptions) => RocketReachClient;
}

const MAX_ACTOR_LENGTH = 64;

function readActor(req: http.IncomingMessage): string {
  const header = req.headers['x-actor'];
  const value = Array.isArray(header) ? header[0] : header;
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, MAX_ACTOR_LENGTH) : 'human';
}

function sendJson<T>(res: http.ServerResponse, statusCode: number, body: ApiResponse<T>) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendError(res: http.ServerResponse, statusCode: number, code: string, message: string) {
  sendJson(res, statusCode, { success: false, error: { code, message } });
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Uint8Array);
  }
  if (chunks.length === 0) {
    return {} as T;
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new RocketReachError('Request body must be valid JSON', 'bad_request');
  }
}

function toState(enabled: boolean, configured: boolean): IntegrationState {
  if (!enabled) return 'disabled';
  return configured ? 'enabled' : 'enabled_unconfigured';
}

function toStatus(settings: { enabled: boolean; apiKey?: string }): RocketReachStatus {
  const configured = Boolean(settings.apiKey);
  return {
    enabled: settings.enabled,
    configured,
    state: toState(settings.enabled, configured),
    ...(settings.apiKey ? { keyHint: maskApiKey(settings.apiKey) } : {}),
  };
}

/** Map a RocketReach/validation error to an HTTP status + code. Message is pre-redacted. */
function errorStatus(error: RocketReachError): number {
  switch (error.code) {
    case 'bad_request':
    case 'lookup_limit_required':
      return 400;
    case 'setup_required':
    case 'integration_disabled':
      return 409;
    case 'invalid_key':
      return 401;
    case 'rate_limited':
      return 429;
    default:
      return 502;
  }
}

function toArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
    return items.length ? items : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return undefined;
}

function normalizeCriteria(body: Record<string, unknown>): RocketReachSearchCriteria {
  const maxCandidatesRaw = typeof body.maxCandidates === 'number' ? body.maxCandidates : undefined;
  const maxCandidates = maxCandidatesRaw
    ? Math.min(Math.max(1, Math.floor(maxCandidatesRaw)), MAX_CANDIDATES_LIMIT)
    : DEFAULT_MAX_CANDIDATES;
  return {
    audience: typeof body.audience === 'string' ? body.audience : undefined,
    titles: toArray(body.titles),
    regions: toArray(body.regions),
    companies: toArray(body.companies),
    industries: toArray(body.industries),
    keywords: toArray(body.keywords),
    maxCandidates,
    requireWorkEmail: Boolean(body.requireWorkEmail),
    dedupe: Boolean(body.dedupe),
    save: body.save === 'fsbrain' ? 'fsbrain' : 'none',
    project: typeof body.project === 'string' ? body.project : undefined,
  };
}

export interface IntegrationRouteResult {
  handled: boolean;
}

export async function handleIntegrationRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: IntegrationRouteDependencies,
): Promise<IntegrationRouteResult> {
  if (!req.url || !req.method) {
    return { handled: false };
  }
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  if (!pathname.startsWith('/api/integrations')) {
    return { handled: false };
  }

  const { integrationStore } = deps;
  const createClient = deps.createRocketReachClient ?? defaultCreateClient;

  /** Build a client from stored settings, or return a fail-closed error response. */
  async function resolveClient(): Promise<
    { ok: true; client: RocketReachClient; apiKey: string } | { ok: false; error: RocketReachError }
  > {
    const settings = await integrationStore.getRocketReach();
    if (!settings.enabled) {
      return {
        ok: false,
        error: new RocketReachError('RocketReach integration is disabled.', 'integration_disabled'),
      };
    }
    if (!settings.apiKey) {
      return {
        ok: false,
        error: new RocketReachError(
          'RocketReach is enabled but no API key is configured. Add a key in settings.',
          'setup_required',
        ),
      };
    }
    return { ok: true, client: createClient({ apiKey: settings.apiKey }), apiKey: settings.apiKey };
  }

  /** Persist a run as a provenance note; returns the saved path. Best-effort audit/event. */
  async function saveRun(record: RocketReachRunRecord): Promise<string> {
    const { path: notePath, content } = buildRunRecordNote(record);
    try {
      await deps.repository.createMarkdownFile(notePath, content);
    } catch {
      // Already exists (same day + label) — overwrite with the latest run.
      await deps.repository.updateMarkdownFile(notePath, content);
    }
    try {
      await deps.auditLog.record({ actor: record.actor, action: 'create', path: notePath });
    } catch {
      /* provenance is best-effort and must not fail the run */
    }
    try {
      deps.eventBus.publish({
        type: 'created',
        path: notePath,
        actor: record.actor,
        ts: new Date().toISOString(),
        source: 'api',
      });
    } catch {
      /* non-fatal */
    }
    return notePath;
  }

  try {
    // GET /api/integrations — all statuses (redacted).
    if (req.method === 'GET' && pathname === '/api/integrations') {
      const settings = await integrationStore.getRocketReach();
      sendJson(res, 200, { success: true, data: { rocketreach: toStatus(settings) } });
      return { handled: true };
    }

    // GET /api/integrations/rocketreach — status (redacted, never the key).
    if (req.method === 'GET' && pathname === '/api/integrations/rocketreach') {
      const settings = await integrationStore.getRocketReach();
      sendJson(res, 200, { success: true, data: toStatus(settings) });
      return { handled: true };
    }

    // PUT /api/integrations/rocketreach — enable/disable and set/remove the key.
    if (req.method === 'PUT' && pathname === '/api/integrations/rocketreach') {
      const body = await readJsonBody<{ enabled?: unknown; apiKey?: unknown }>(req);
      const patch: { enabled?: boolean; apiKey?: string | null } = {};
      if (body.enabled !== undefined) {
        patch.enabled = Boolean(body.enabled);
      }
      if (body.apiKey !== undefined) {
        // null / '' removes the key; a string sets it.
        patch.apiKey = body.apiKey === null ? null : String(body.apiKey);
      }
      const updated = await integrationStore.setRocketReach(patch);
      sendJson(res, 200, { success: true, data: toStatus(updated) });
      return { handled: true };
    }

    // GET /api/integrations/rocketreach/intake — the static intake questions.
    if (req.method === 'GET' && pathname === '/api/integrations/rocketreach/intake') {
      sendJson(res, 200, { success: true, data: { questions: ROCKETREACH_INTAKE_QUESTIONS } });
      return { handled: true };
    }

    // POST /api/integrations/rocketreach/test — connection test (account + credits).
    if (req.method === 'POST' && pathname === '/api/integrations/rocketreach/test') {
      const resolved = await resolveClient();
      if (!resolved.ok) {
        sendError(res, errorStatus(resolved.error), resolved.error.code, resolved.error.message);
        return { handled: true };
      }
      const account = await resolved.client.getAccountStatus();
      sendJson(res, 200, { success: true, data: { connected: true, account } });
      return { handled: true };
    }

    // POST /api/integrations/rocketreach/search — search only (no paid lookups).
    if (req.method === 'POST' && pathname === '/api/integrations/rocketreach/search') {
      const resolved = await resolveClient();
      if (!resolved.ok) {
        sendError(res, errorStatus(resolved.error), resolved.error.code, resolved.error.message);
        return { handled: true };
      }
      const body = await readJsonBody<Record<string, unknown>>(req);
      const criteria = normalizeCriteria(body);
      const candidates = await resolved.client.search(
        criteria,
        criteria.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
      );

      let savedTo: string | undefined;
      if (criteria.save === 'fsbrain') {
        savedTo = await saveRun({
          generatedAt: new Date().toISOString(),
          actor: readActor(req),
          criteria,
          candidates,
          enriched: [],
          project: criteria.project,
        });
      }
      sendJson(res, 200, {
        success: true,
        data: { candidates, count: candidates.length, ...(savedTo ? { savedTo } : {}) },
      });
      return { handled: true };
    }

    // POST /api/integrations/rocketreach/lookup — paid enrichment with a hard cap.
    if (req.method === 'POST' && pathname === '/api/integrations/rocketreach/lookup') {
      const body = await readJsonBody<Record<string, unknown>>(req);
      const ids = toArray(body.ids) ?? [];
      const maxLookupsRaw = body.maxLookups;
      // A paid lookup MUST carry an explicit, positive limit — fail closed otherwise.
      if (
        typeof maxLookupsRaw !== 'number' ||
        !Number.isFinite(maxLookupsRaw) ||
        maxLookupsRaw < 1
      ) {
        sendError(
          res,
          400,
          'lookup_limit_required',
          'A positive integer "maxLookups" is required before any paid lookup.',
        );
        return { handled: true };
      }
      const maxLookups = Math.floor(maxLookupsRaw);
      if (ids.length === 0) {
        sendError(res, 400, 'bad_request', 'At least one candidate "ids" entry is required.');
        return { handled: true };
      }

      const resolved = await resolveClient();
      if (!resolved.ok) {
        sendError(res, errorStatus(resolved.error), resolved.error.code, resolved.error.message);
        return { handled: true };
      }

      // Never enrich more than the cap; the overflow is reported, not spent.
      const toEnrich = ids.slice(0, maxLookups);
      const skipped = ids
        .slice(maxLookups)
        .map((id) => ({ id, reason: 'over_lookup_limit' as const }));

      let creditsBefore: number | undefined;
      try {
        creditsBefore = (await resolved.client.getAccountStatus()).lookupCreditBalance;
      } catch {
        /* budgeting is advisory; a failed pre-check must not block the lookup */
      }
      const enriched = await resolved.client.lookup(toEnrich);
      let creditsAfter: number | undefined;
      try {
        creditsAfter = (await resolved.client.getAccountStatus()).lookupCreditBalance;
      } catch {
        /* advisory */
      }

      const criteria = normalizeCriteria(body);
      const candidates: RocketReachCandidate[] = enriched.map((c) => ({
        id: c.id,
        name: c.name,
        title: c.title,
        company: c.company,
        location: c.location,
        linkedinUrl: c.linkedinUrl,
        profileUrl: c.profileUrl,
      }));

      let savedTo: string | undefined;
      if (criteria.save === 'fsbrain') {
        savedTo = await saveRun({
          generatedAt: new Date().toISOString(),
          actor: readActor(req),
          criteria,
          creditsBefore,
          creditsAfter,
          candidates,
          enriched: enriched as RocketReachContact[],
          skipped,
          project: criteria.project,
        });
      }

      sendJson(res, 200, {
        success: true,
        data: {
          contacts: enriched,
          enrichedCount: enriched.length,
          skipped,
          creditsBefore,
          creditsAfter,
          ...(savedTo ? { savedTo } : {}),
        },
      });
      return { handled: true };
    }

    return { handled: false };
  } catch (error: unknown) {
    // Defense in depth: redact the stored key from any leaked message.
    let apiKey: string | undefined;
    try {
      apiKey = (await integrationStore.getRocketReach()).apiKey;
    } catch {
      /* ignore */
    }
    if (error instanceof RocketReachError) {
      const message = redactSecrets(error.message, [apiKey]);
      sendError(res, errorStatus(error), error.code, message);
      return { handled: true };
    }
    const raw = error instanceof Error ? error.message : 'Unexpected error';
    sendError(res, 500, 'integration_error', redactSecrets(raw, [apiKey]));
    return { handled: true };
  }
}
