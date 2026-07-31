import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Persisted settings for optional integrations, stored as a single JSON file
 * under the hidden `.fsbrain/` directory inside CONTENT_ROOT — the same place
 * as the audit log, and excluded from the user-facing file tree. This is where
 * an integration's on/off flag and its API key live.
 *
 * Why here and not in a note: the key must never land in the markdown vault
 * (which the user may commit to git or share). `.fsbrain/` is internal state,
 * and the file is written with owner-only permissions (0600).
 */
export interface RocketReachSettings {
  enabled: boolean;
  /** The user's RocketReach API key. Never returned to the web/MCP surface raw. */
  apiKey?: string;
}

interface IntegrationsFile {
  rocketreach?: RocketReachSettings;
}

export interface IntegrationStore {
  getRocketReach(): Promise<RocketReachSettings>;
  /**
   * Merge a partial update. `enabled` is set when provided. For `apiKey`:
   * a string sets it, `null` or `''` removes it, and `undefined` leaves it
   * untouched (so toggling `enabled` never clobbers a stored key).
   */
  setRocketReach(patch: {
    enabled?: boolean;
    apiKey?: string | null;
  }): Promise<RocketReachSettings>;
}

export const INTEGRATIONS_DIR = '.fsbrain';
export const INTEGRATIONS_FILE = 'integrations.json';

const DEFAULT_ROCKETREACH: RocketReachSettings = { enabled: false };

export function createIntegrationStore(rootPath: string): IntegrationStore {
  const dir = path.join(rootPath, INTEGRATIONS_DIR);
  const file = path.join(dir, INTEGRATIONS_FILE);

  async function readFile(): Promise<IntegrationsFile> {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as IntegrationsFile;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      // A corrupt file should not brick the integration — treat as empty.
      return {};
    }
  }

  async function writeFile(data: IntegrationsFile): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    // Owner read/write only — this file holds a secret.
    await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    // Re-assert perms in case the file pre-existed with laxer bits.
    await fs.chmod(file, 0o600).catch(() => {
      /* best-effort on platforms without chmod semantics */
    });
  }

  async function getRocketReach(): Promise<RocketReachSettings> {
    const data = await readFile();
    const rr = data.rocketreach;
    if (!rr || typeof rr !== 'object') {
      return { ...DEFAULT_ROCKETREACH };
    }
    return {
      enabled: Boolean(rr.enabled),
      ...(rr.apiKey ? { apiKey: rr.apiKey } : {}),
    };
  }

  async function setRocketReach(patch: {
    enabled?: boolean;
    apiKey?: string | null;
  }): Promise<RocketReachSettings> {
    const data = await readFile();
    const current: RocketReachSettings = data.rocketreach
      ? { enabled: Boolean(data.rocketreach.enabled), apiKey: data.rocketreach.apiKey }
      : { ...DEFAULT_ROCKETREACH };

    if (patch.enabled !== undefined) {
      current.enabled = patch.enabled;
    }

    if (patch.apiKey !== undefined) {
      const trimmed = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : '';
      if (trimmed) {
        current.apiKey = trimmed;
      } else {
        delete current.apiKey;
      }
    }

    const next: IntegrationsFile = { ...data, rocketreach: current };
    await writeFile(next);
    return { enabled: current.enabled, ...(current.apiKey ? { apiKey: current.apiKey } : {}) };
  }

  return { getRocketReach, setRocketReach };
}
