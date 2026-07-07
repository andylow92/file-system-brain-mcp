/**
 * Server-side config for the **optional** embedding retrieval engine.
 *
 * The vault's semantic search is TF-IDF by default — fully offline, no key, no
 * network. Real vector embeddings are strictly opt-in: they only ever run when
 * `FSBRAIN_EMBEDDINGS` is turned on *and* an API key is present. With embeddings
 * off (the default), `loadEmbeddingConfig()` returns `null` and the vault keeps
 * using the offline TF-IDF engine — the escape hatch is a single env var.
 *
 * Mirrors `think/synthesize.ts`: the key is read from the environment so the
 * server never embeds a secret, and the provider is any OpenAI-compatible
 * `/v1/embeddings` endpoint (OpenRouter's default is used when unset). Falls back
 * to `OPENROUTER_API_KEY` so a vault already configured for `think` synthesis can
 * enable embeddings by flipping the toggle alone.
 */

/** Default provider: OpenAI-compatible embeddings over OpenRouter. */
const DEFAULT_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';
const DEFAULT_EMBEDDINGS_MODEL = 'openai/text-embedding-3-small';

export interface EmbeddingConfig {
  url: string;
  apiKey: string;
  model: string;
  /** How many texts to send per request (bounded to keep payloads sane). */
  batchSize: number;
}

/** Truthy env flag: `1`, `true`, `on`, `yes` (case-insensitive). Anything else is off. */
function isEnabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return ['1', 'true', 'on', 'yes'].includes(value.trim().toLowerCase());
}

/**
 * Whether the operator asked for embeddings via `FSBRAIN_EMBEDDINGS`, regardless
 * of whether a key is present. Lets callers distinguish "off" (stay quiet) from
 * "on but misconfigured" (worth a startup warning).
 */
export function isEmbeddingsRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabled(env.FSBRAIN_EMBEDDINGS);
}

/**
 * Read embedding config from the environment. Returns `null` — the signal to
 * stay on the offline TF-IDF engine — unless `FSBRAIN_EMBEDDINGS` is on and a key
 * (`EMBEDDINGS_API_KEY`, else `OPENROUTER_API_KEY`) is set. `EMBEDDINGS_MODEL`,
 * `EMBEDDINGS_URL`, and `EMBEDDINGS_BATCH_SIZE` override the defaults.
 */
export function loadEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig | null {
  if (!isEnabled(env.FSBRAIN_EMBEDDINGS)) {
    return null;
  }
  const apiKey = env.EMBEDDINGS_API_KEY?.trim() || env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }
  const url = env.EMBEDDINGS_URL?.trim() || DEFAULT_EMBEDDINGS_URL;
  const model = env.EMBEDDINGS_MODEL?.trim() || DEFAULT_EMBEDDINGS_MODEL;
  const parsedBatch = Number(env.EMBEDDINGS_BATCH_SIZE);
  const batchSize = Number.isFinite(parsedBatch) && parsedBatch > 0 ? Math.floor(parsedBatch) : 96;
  return { url, apiKey, model, batchSize };
}
