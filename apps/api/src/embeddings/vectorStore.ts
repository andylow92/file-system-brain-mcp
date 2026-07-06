/**
 * On-disk persistence for embedding vectors, so a restart doesn't re-embed the
 * whole vault from the provider (cost + latency + network on every boot).
 *
 * The store is a **content-addressed cache**: it maps a chunk's hash → its dense
 * vector. Keying by content (not path) means a moved or renamed note keeps its
 * cached vectors, and only genuinely changed text is re-embedded. Vectors are
 * model-specific, so the file records the embedding `model`; loading under a
 * different model discards everything (the vectors are incompatible) rather than
 * mixing spaces.
 *
 * It lives beside the audit / question logs under the hidden `.fsbrain/`
 * directory (excluded from the file tree and the corpus). Every operation is
 * **best-effort**: a missing, corrupt, wrong-version, or wrong-model file loads
 * as empty, and callers treat a save failure as "not persisted this time" — the
 * cache is a performance optimization, never a source of truth.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const EMBEDDINGS_DIR = '.fsbrain';
export const EMBEDDINGS_FILE = 'embeddings.json';

/** Bump when the on-disk shape changes so old files load as empty. */
const STORE_VERSION = 1;

export interface VectorStore {
  /** Load the persisted vectors for `model`; empty map if none/mismatch/corrupt. */
  load(model: string): Promise<Map<string, number[]>>;
  /** Persist `vectors` tagged with `model`, replacing any prior file. */
  save(model: string, vectors: Map<string, number[]>): Promise<void>;
}

interface PersistShape {
  version: number;
  model: string;
  /** hash → dense vector. */
  vectors: Record<string, number[]>;
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** Parse + validate a loaded payload for `model`, tolerating any corruption. */
function decode(raw: string, model: string): Map<string, number[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return new Map();
  }
  const shape = parsed as Partial<PersistShape>;
  if (
    shape.version !== STORE_VERSION ||
    shape.model !== model ||
    typeof shape.vectors !== 'object'
  ) {
    return new Map();
  }
  const out = new Map<string, number[]>();
  for (const [key, value] of Object.entries(shape.vectors ?? {})) {
    if (isNumberArray(value)) {
      out.set(key, value);
    }
  }
  return out;
}

/**
 * A `VectorStore` backed by `<rootPath>/.fsbrain/embeddings.json`. Writes are
 * atomic (temp file + rename) so a crash mid-write can't leave a torn file that
 * poisons the cache.
 */
export function createFileVectorStore(rootPath: string): VectorStore {
  const dir = path.join(rootPath, EMBEDDINGS_DIR);
  const file = path.join(dir, EMBEDDINGS_FILE);

  return {
    async load(model: string): Promise<Map<string, number[]>> {
      let raw: string;
      try {
        raw = await fs.readFile(file, 'utf8');
      } catch {
        // Missing (first run) or unreadable — start cold.
        return new Map();
      }
      return decode(raw, model);
    },

    async save(model: string, vectors: Map<string, number[]>): Promise<void> {
      const payload: PersistShape = {
        version: STORE_VERSION,
        model,
        vectors: Object.fromEntries(vectors),
      };
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
      await fs.rename(tmp, file);
    },
  };
}
