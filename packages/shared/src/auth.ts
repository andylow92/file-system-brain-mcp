/**
 * Optional SPIFFE-based authentication for the vault API.
 *
 * The vault is local-first: with auth disabled (the default) nothing changes —
 * the API trusts its network like it always has. Enabling auth (Settings → Vault
 * access, or `PUT /api/auth`) makes remote requests prove a SPIFFE workload
 * identity (https://spiffe.io): a JWT-SVID bearer token or an mTLS X.509-SVID.
 * The verified SPIFFE ID becomes the audit-log actor, so multi-agent writes are
 * attributed to a cryptographic identity instead of a self-declared header.
 *
 * This module is pure (no I/O): SPIFFE ID parsing, access-rule resolution, and
 * the wire types shared by the API routes, the web settings dialog, and docs.
 */

/** Maximum total length of a SPIFFE ID we accept (the spec's ceiling). */
export const MAX_SPIFFE_ID_LENGTH = 2048;

/** What an authenticated identity may do. Ordered: each level includes the previous. */
export const AUTH_ACCESS_LEVELS = ['read', 'readwrite', 'admin'] as const;
export type AuthAccess = (typeof AUTH_ACCESS_LEVELS)[number];

/** Access granted to valid identities that match no explicit rule. */
export type AuthDefaultAccess = 'none' | 'read' | 'readwrite';

export interface SpiffeId {
  /** Lowercase trust domain, e.g. `example.org`. */
  trustDomain: string;
  /** Path including the leading slash, or empty string for a bare domain id. */
  path: string;
  /** The normalized full id, `spiffe://<trustDomain><path>`. */
  id: string;
}

const TRUST_DOMAIN_PATTERN = /^[a-z0-9._-]{1,255}$/;
const PATH_SEGMENT_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * Parse and validate a SPIFFE ID string per the SPIFFE spec (scheme, lowercase
 * trust domain charset, path segment charset, no `.`/`..` segments, no
 * query/fragment/port/userinfo). Returns `null` for anything invalid — callers
 * treat that as "not a SPIFFE identity", never as an error to swallow.
 */
export function parseSpiffeId(value: string): SpiffeId | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_SPIFFE_ID_LENGTH) return null;
  if (!value.startsWith('spiffe://')) return null;

  const rest = value.slice('spiffe://'.length);
  if (!rest) return null;
  // Query strings, fragments, userinfo, and ports are all forbidden by the spec.
  if (rest.includes('?') || rest.includes('#') || rest.includes('@')) return null;

  const slash = rest.indexOf('/');
  const trustDomain = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash);

  if (!TRUST_DOMAIN_PATTERN.test(trustDomain)) return null;
  if (trustDomain.includes(':')) return null;

  if (path) {
    // A trailing slash means an empty final segment — invalid.
    if (path.endsWith('/')) return null;
    const segments = path.slice(1).split('/');
    for (const segment of segments) {
      if (!segment || segment === '.' || segment === '..') return null;
      if (!PATH_SEGMENT_PATTERN.test(segment)) return null;
    }
  }

  return { trustDomain, path, id: `spiffe://${trustDomain}${path}` };
}

/** Validate a bare trust-domain name (what the settings store). */
export function isValidTrustDomain(value: string): boolean {
  return typeof value === 'string' && TRUST_DOMAIN_PATTERN.test(value) && !value.includes(':');
}

/**
 * One access rule. `exact` matches the whole id; `prefix` matches ids that
 * start with `id` (use a trailing `/` to scope a subtree, e.g.
 * `spiffe://example.org/readonly/`).
 */
export interface AuthAgentRule {
  id: string;
  match: 'exact' | 'prefix';
  access: AuthAccess;
  /** Optional operator note ("the research crawler"), shown in settings. */
  note?: string;
}

/**
 * Resolve the access level for a verified SPIFFE ID. Exact rules win over
 * prefix rules; among prefix rules the longest match wins; ties keep the first
 * rule in configured order. Falls back to `defaultAccess` (where `'none'`
 * resolves to `null`, meaning: authenticated but not authorized).
 */
export function resolveAgentAccess(
  spiffeId: string,
  rules: readonly AuthAgentRule[],
  defaultAccess: AuthDefaultAccess,
): AuthAccess | null {
  let best: { rule: AuthAgentRule; specificity: number } | null = null;
  for (const rule of rules) {
    if (rule.match === 'exact') {
      if (rule.id === spiffeId) return rule.access;
      continue;
    }
    if (spiffeId.startsWith(rule.id)) {
      if (!best || rule.id.length > best.specificity) {
        best = { rule, specificity: rule.id.length };
      }
    }
  }
  if (best) return best.rule.access;
  return defaultAccess === 'none' ? null : defaultAccess;
}

/** True when `granted` covers `needed` (read < readwrite < admin). */
export function accessAllows(granted: AuthAccess, needed: AuthAccess): boolean {
  return AUTH_ACCESS_LEVELS.indexOf(granted) >= AUTH_ACCESS_LEVELS.indexOf(needed);
}

/** Where the JWT-SVID verification keys come from. Exactly one is set. */
export interface AuthJwksSource {
  /** Inline JWKS JSON (`{"keys":[…]}`) pasted into settings. */
  inline?: string;
  /** Absolute path to a JWKS file on the server's disk (e.g. spiffe-helper output). */
  file?: string;
  /** JWKS URL (e.g. a SPIRE OIDC discovery provider's `/keys`). */
  url?: string;
}

/** Persisted auth settings (`.fsbrain/auth.json`). Defaults: disabled, open. */
export interface AuthSettings {
  enabled: boolean;
  /** Required to enable. Only identities in this trust domain are accepted. */
  trustDomain?: string;
  /** Expected JWT `aud` claim on bearer tokens. */
  audience: string;
  /**
   * Keep loopback (127.0.0.0/8, ::1) requests exempt while auth is enabled, so
   * the local web UI and embedded MCP keep working with zero setup. Turn off
   * when a reverse proxy on the same host makes remote traffic look local.
   */
  allowLoopback: boolean;
  jwks?: AuthJwksSource;
  defaultAccess: AuthDefaultAccess;
  agents: AuthAgentRule[];
}

export const DEFAULT_AUTH_AUDIENCE = 'fsbrain';

export const DEFAULT_AUTH_SETTINGS: AuthSettings = {
  enabled: false,
  audience: DEFAULT_AUTH_AUDIENCE,
  allowLoopback: true,
  defaultAccess: 'readwrite',
  agents: [],
};

/** How the caller of `GET /api/auth` was admitted. */
export type AuthCallerKind = 'loopback' | 'spiffe' | 'open';

/** Safe status payload for the settings dialog and agent debugging. No key material. */
export interface AuthStatusResponse {
  enabled: boolean;
  /** True when a trust domain is configured (auth can actually verify). */
  configured: boolean;
  state: 'disabled' | 'enabled';
  trustDomain?: string;
  audience: string;
  allowLoopback: boolean;
  defaultAccess: AuthDefaultAccess;
  /** Which JWKS source kind is configured, if any (never the material itself). */
  jwksSource?: 'inline' | 'file' | 'url';
  /** True when bearer tokens can be verified (a JWKS source is configured). */
  bearerReady: boolean;
  /** Full rules — only included for loopback or admin callers. */
  agents?: AuthAgentRule[];
  /** How this request was admitted, and as whom. */
  caller: { kind: AuthCallerKind; spiffeId?: string; access?: AuthAccess };
}

/** Result of `POST /api/auth/test` — dry-run verification of a pasted token. */
export interface AuthTestResponse {
  valid: boolean;
  spiffeId?: string;
  access?: AuthAccess | null;
  reason?: string;
}
