/**
 * Minimal client for an OpenAI-compatible `/v1/embeddings` provider.
 *
 * This is the only part of the embedding engine that touches the network. It is
 * kept tiny and dependency-free (`fetch`), mirroring `think/synthesize.ts`'s
 * OpenRouter wiring. Callers treat any thrown error as "embeddings unavailable"
 * and fall back to the offline TF-IDF engine, so a transport failure degrades
 * gracefully rather than breaking search.
 */
import type { EmbeddingConfig } from './config.js';

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  error?: { message?: string };
}

/** How the engine embeds a batch of texts; injectable so tests avoid the network. */
export type EmbedFn = (texts: string[], signal?: AbortSignal) => Promise<number[][]>;

/** POST one batch of texts to the provider and return their vectors, in order. */
async function embedBatch(
  config: EmbeddingConfig,
  texts: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  const response = await fetch(config.url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'X-Title': 'fsbrain embeddings',
    },
    body: JSON.stringify({ model: config.model, input: texts }),
  });

  let payload: EmbeddingResponse | null = null;
  try {
    payload = (await response.json()) as EmbeddingResponse;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(
      payload?.error?.message ?? `Embeddings request failed with status ${response.status}`,
    );
  }

  const data = payload?.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error('Embeddings response shape did not match the request.');
  }

  // Providers may return `index` out of order; sort defensively before mapping.
  const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return ordered.map((entry) => {
    if (!Array.isArray(entry.embedding) || entry.embedding.length === 0) {
      throw new Error('Embeddings response contained an empty vector.');
    }
    return entry.embedding;
  });
}

/**
 * Build an `EmbedFn` bound to a config: embeds arbitrarily many texts by chunking
 * them into `batchSize` requests (sequential to stay under provider rate limits)
 * and concatenating the vectors in input order.
 *
 * Empty or whitespace-only inputs are sent as a single space: many providers 400
 * on an empty string, and one such input would otherwise fail the whole batch and
 * force a corpus-wide fall back to TF-IDF. The substitute keeps the returned
 * vectors parallel to `texts`; the vector for a blank chunk is meaningless, but
 * the chunk carried no content to rank on anyway.
 */
export function createEmbedFn(config: EmbeddingConfig): EmbedFn {
  return async (texts, signal) => {
    const safeTexts = texts.map((text) => (text.trim().length > 0 ? text : ' '));
    const vectors: number[][] = [];
    for (let i = 0; i < safeTexts.length; i += config.batchSize) {
      const batch = safeTexts.slice(i, i + config.batchSize);
      vectors.push(...(await embedBatch(config, batch, signal)));
    }
    return vectors;
  };
}
