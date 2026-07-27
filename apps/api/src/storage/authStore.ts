import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_AUTH_SETTINGS,
  isValidTrustDomain,
  parseSpiffeId,
  AUTH_ACCESS_LEVELS,
  type AuthAgentRule,
  type AuthDefaultAccess,
  type AuthJwksSource,
  type AuthSettings,
} from '@repo/shared';

/**
 * Persisted auth settings, stored as `.fsbrain/auth.json` under CONTENT_ROOT —
 * the same hidden internal-state directory as the audit log, excluded from the
 * user-facing file tree. Holds no secrets (a trust domain, public verification
 * key locations, and access rules), but is written with owner-only permissions
 * and atomically (write-then-rename) like its sibling stores, and a catch-all
 * `.fsbrain/.gitignore` is seeded so a version-controlled vault never commits
 * internal state.
 *
 * Defaults to `enabled: false`: a vault that never turns auth on behaves
 * exactly as before this file existed.
 */

export const AUTH_DIR = '.fsbrain';
export const AUTH_FILE = 'auth.json';

const MAX_AGENT_RULES = 200;
const MAX_NOTE_LENGTH = 200;
const MAX_AUDIENCE_LENGTH = 120;
const MAX_INLINE_JWKS_LENGTH = 64 * 1024;

/** Patch semantics: provided fields update, omitted fields stay untouched. */
export interface AuthSettingsPatch {
  enabled?: boolean;
  /** A string sets it; `null` clears it (only allowed while disabled). */
  trustDomain?: string | null;
  audience?: string;
  allowLoopback?: boolean;
  /** An object sets the source; `null` removes JWKS entirely. */
  jwks?: AuthJwksSource | null;
  defaultAccess?: AuthDefaultAccess;
  agents?: AuthAgentRule[];
}

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

export interface AuthStore {
  getAuth(): Promise<AuthSettings>;
  setAuth(patch: AuthSettingsPatch): Promise<AuthSettings>;
}

function sanitizeRules(value: unknown): AuthAgentRule[] {
  if (!Array.isArray(value)) return [];
  const rules: AuthAgentRule[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, match, access, note } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !id.startsWith('spiffe://')) continue;
    if (match !== 'exact' && match !== 'prefix') continue;
    if (!AUTH_ACCESS_LEVELS.includes(access as (typeof AUTH_ACCESS_LEVELS)[number])) continue;
    rules.push({
      id,
      match,
      access: access as AuthAgentRule['access'],
      ...(typeof note === 'string' && note ? { note: note.slice(0, MAX_NOTE_LENGTH) } : {}),
    });
  }
  return rules;
}

/** Normalize whatever is on disk into a well-formed settings object. */
function sanitizeSettings(raw: unknown): AuthSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_AUTH_SETTINGS };
  const value = raw as Record<string, unknown>;
  const trustDomain =
    typeof value.trustDomain === 'string' && isValidTrustDomain(value.trustDomain)
      ? value.trustDomain
      : undefined;
  const audience =
    typeof value.audience === 'string' && value.audience.trim()
      ? value.audience.trim()
      : DEFAULT_AUTH_SETTINGS.audience;
  const defaultAccess =
    value.defaultAccess === 'none' || value.defaultAccess === 'read'
      ? value.defaultAccess
      : 'readwrite';
  let jwks: AuthJwksSource | undefined;
  if (value.jwks && typeof value.jwks === 'object') {
    const { inline, file, url } = value.jwks as Record<string, unknown>;
    if (typeof inline === 'string' && inline) jwks = { inline };
    else if (typeof file === 'string' && file) jwks = { file };
    else if (typeof url === 'string' && url) jwks = { url };
  }
  return {
    // A stored enabled flag without a valid trust domain cannot verify anyone;
    // treat it as disabled rather than locking every remote request out on a
    // config that can never pass.
    enabled: Boolean(value.enabled) && trustDomain !== undefined,
    ...(trustDomain ? { trustDomain } : {}),
    audience,
    allowLoopback: value.allowLoopback === undefined ? true : Boolean(value.allowLoopback),
    ...(jwks ? { jwks } : {}),
    defaultAccess,
    agents: sanitizeRules(value.agents),
  };
}

function validateRulesForWrite(rules: AuthAgentRule[], trustDomain: string | undefined): void {
  if (rules.length > MAX_AGENT_RULES) {
    throw new AuthConfigError(`At most ${MAX_AGENT_RULES} agent rules are supported.`);
  }
  for (const rule of rules) {
    const probe = rule.match === 'prefix' ? rule.id.replace(/\/$/, '') : rule.id;
    const parsed = parseSpiffeId(probe);
    if (!parsed) {
      throw new AuthConfigError(`Agent rule id is not a valid SPIFFE ID: ${rule.id}`);
    }
    if (trustDomain && parsed.trustDomain !== trustDomain) {
      throw new AuthConfigError(
        `Agent rule ${rule.id} is outside trust domain ${trustDomain} — only identities in the configured trust domain can ever authenticate, so the rule would never match.`,
      );
    }
  }
}

function validateJwksForWrite(jwks: AuthJwksSource): AuthJwksSource {
  const sources = [jwks.inline, jwks.file, jwks.url].filter(
    (entry) => typeof entry === 'string' && entry.trim(),
  );
  if (sources.length !== 1) {
    throw new AuthConfigError('JWKS must set exactly one of inline, file, or url.');
  }
  if (jwks.inline !== undefined) {
    const inline = jwks.inline.trim();
    if (inline.length > MAX_INLINE_JWKS_LENGTH) {
      throw new AuthConfigError('Inline JWKS is too large.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(inline);
    } catch {
      throw new AuthConfigError('Inline JWKS must be valid JSON.');
    }
    const keys = (parsed as { keys?: unknown })?.keys;
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new AuthConfigError('Inline JWKS must contain a non-empty "keys" array.');
    }
    return { inline };
  }
  if (jwks.file !== undefined) {
    const file = jwks.file.trim();
    if (!path.isAbsolute(file)) {
      throw new AuthConfigError('JWKS file path must be absolute.');
    }
    return { file };
  }
  const url = jwks.url!.trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new AuthConfigError('JWKS url must be a valid URL.');
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new AuthConfigError('JWKS url must be http(s).');
  }
  return { url };
}

export function createAuthStore(rootPath: string): AuthStore {
  const dir = path.join(rootPath, AUTH_DIR);
  const file = path.join(dir, AUTH_FILE);
  const gitignore = path.join(dir, '.gitignore');

  async function readFile(): Promise<AuthSettings> {
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ...DEFAULT_AUTH_SETTINGS };
      }
      // A real I/O fault (permissions, disk) must surface, not silently read
      // back as "auth disabled" — that would fail open.
      throw error;
    }
    try {
      return sanitizeSettings(JSON.parse(raw));
    } catch {
      // A corrupt file must not brick the vault; the owner can re-enable from
      // loopback. Failing closed here would lock the API with no way back in.
      return { ...DEFAULT_AUTH_SETTINGS };
    }
  }

  async function writeFile(settings: AuthSettings): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    // `.fsbrain/` holds internal state (audit log, proposals, this file) that a
    // version-controlled vault should never commit. Seed a catch-all ignore
    // once; never overwrite one the owner customized.
    try {
      await fs.writeFile(gitignore, '*\n', { encoding: 'utf8', flag: 'wx' });
    } catch {
      // Already exists (or unwritable) — best-effort either way.
    }
    // Write-then-rename so a crash mid-write can never leave a truncated file,
    // with owner-only permissions like the sibling stores.
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.chmod(tmp, 0o600).catch(() => {
      // Best-effort on platforms without chmod semantics.
    });
    await fs.rename(tmp, file);
  }

  // Updates queue behind this promise so concurrent read-modify-writes cannot
  // interleave (an enable toggle racing a rules edit must not revert either).
  let updateQueue: Promise<unknown> = Promise.resolve();
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = updateQueue.then(task, task);
    updateQueue = run.catch(() => {
      // Keep the queue alive after a failed update.
    });
    return run;
  }

  function setAuth(patch: AuthSettingsPatch): Promise<AuthSettings> {
    return serialize(async () => {
      const current = await readFile();
      const next: AuthSettings = { ...current, agents: [...current.agents] };

      if (patch.trustDomain !== undefined) {
        if (patch.trustDomain === null || patch.trustDomain.trim() === '') {
          delete next.trustDomain;
        } else {
          const trimmed = patch.trustDomain.trim();
          if (!isValidTrustDomain(trimmed)) {
            throw new AuthConfigError(
              'Trust domain must be 1-255 lowercase letters, digits, dots, dashes, or underscores.',
            );
          }
          next.trustDomain = trimmed;
        }
      }

      if (patch.audience !== undefined) {
        const trimmed = patch.audience.trim();
        if (!trimmed || trimmed.length > MAX_AUDIENCE_LENGTH) {
          throw new AuthConfigError('Audience must be a non-empty short string.');
        }
        next.audience = trimmed;
      }

      if (patch.allowLoopback !== undefined) {
        next.allowLoopback = Boolean(patch.allowLoopback);
      }

      if (patch.jwks !== undefined) {
        if (patch.jwks === null) {
          delete next.jwks;
        } else {
          next.jwks = validateJwksForWrite(patch.jwks);
        }
      }

      if (patch.defaultAccess !== undefined) {
        if (!['none', 'read', 'readwrite'].includes(patch.defaultAccess)) {
          throw new AuthConfigError('defaultAccess must be none, read, or readwrite.');
        }
        next.defaultAccess = patch.defaultAccess;
      }

      if (patch.agents !== undefined) {
        if (!Array.isArray(patch.agents)) {
          throw new AuthConfigError('agents must be an array of rules.');
        }
        next.agents = sanitizeRules(patch.agents);
        if (next.agents.length !== patch.agents.length) {
          throw new AuthConfigError(
            'Every agent rule needs a spiffe:// id, match (exact|prefix), and access (read|readwrite|admin).',
          );
        }
      }

      if (patch.enabled !== undefined) {
        next.enabled = Boolean(patch.enabled);
      }

      // Enabling requires a trust domain; a missing JWKS stays allowed (an
      // mTLS-only deployment verifies via client certificates instead).
      if (next.enabled && !next.trustDomain) {
        throw new AuthConfigError('Enabling auth requires a trust domain.');
      }
      validateRulesForWrite(next.agents, next.trustDomain);

      await writeFile(next);
      return next;
    });
  }

  return { getAuth: readFile, setAuth };
}
