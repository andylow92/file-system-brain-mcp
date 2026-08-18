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
 * the file is written with owner-only permissions (0600), and `ensureContentRoot`
 * seeds a catch-all `.fsbrain/.gitignore` so a version-controlled vault can
 * never commit it.
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
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      // A real I/O fault (permissions, disk) must surface, not read back as
      // "disabled/unconfigured" — a later write would clobber the real file.
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as IntegrationsFile;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      // A corrupt file should not brick the integration — treat as empty.
      return {};
    }
  }

  async function writeFile(data: IntegrationsFile): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    // Write-then-rename so a crash mid-write can never leave a truncated file,
    // with owner-only permissions — this file holds a secret.
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    // Re-assert perms in case a stale temp file pre-existed with laxer bits.
    await fs.chmod(tmp, 0o600).catch(() => {
      /* best-effort on platforms without chmod semantics */
    });
    await fs.rename(tmp, file);
  }

  /**
   * Updates queue behind this promise so concurrent read-modify-writes cannot
   * interleave (a toggle-only PUT racing a key PUT must not revert either).
   */
  let updateQueue: Promise<unknown> = Promise.resolve();
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = updateQueue.then(task, task);
    updateQueue = run.catch(() => {
      /* keep the queue alive after a failed update */
    });
    return run;
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

  function setRocketReach(patch: {
    enabled?: boolean;
    apiKey?: string | null;
  }): Promise<RocketReachSettings> {
    return serialize(async () => {
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
    });
  }

  return { getRocketReach, setRocketReach };
}
