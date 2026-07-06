/**
 * The retrieval **engine** seam: a small interface the `VaultIndex` builds and
 * queries through, with two interchangeable implementations behind it.
 *
 * - `tfidf` (default) — wraps the offline TF-IDF ranker in `@repo/shared`
 *   verbatim. No network, no key: exactly the vault's historical behaviour.
 * - `embeddings` (opt-in) — chunks the corpus, embeds each chunk via a provider
 *   (`EmbedFn`), and ranks by dense cosine. Same `documents → ranked` contract.
 *
 * The two are drop-in interchangeable: both return the same `SemanticHit` /
 * `RankedChunk` shapes, so nothing downstream of the `VaultIndex` (the
 * semantic-search / hybrid / think / context routes) changes when the engine is
 * swapped. Selection is a single env toggle (`FSBRAIN_EMBEDDINGS`), and a
 * resilient wrapper falls back to TF-IDF if embeddings can't build — so "off" is
 * always a working search, whether chosen or forced by a provider outage.
 */
import {
  buildSemanticIndex,
  chunkDocuments,
  embeddableText,
  queryEmbeddingHits,
  queryEmbeddingIndex,
  queryRankedChunks,
  querySemanticIndex,
  type EmbeddingIndex,
  type RankQueryOptions,
  type RankedChunk,
  type SemanticDocument,
  type SemanticHit,
} from '@repo/shared';

import type { EmbedFn } from '../embeddings/client.js';
import { loadEmbeddingConfig } from '../embeddings/config.js';
import { createEmbedFn } from '../embeddings/client.js';

/** A corpus that has been indexed and can be queried. Carries its own query
 * closures so the `VaultIndex` never needs to know which engine built it. */
export interface BuiltRetrievalIndex {
  querySemantic(query: string, options: RankQueryOptions): Promise<SemanticHit[]>;
  queryRanked(query: string, options: RankQueryOptions): Promise<RankedChunk[]>;
}

export interface RetrievalEngine {
  /** Which engine this is — surfaced in logs and health output. */
  readonly name: 'tfidf' | 'embeddings';
  build(documents: readonly SemanticDocument[]): Promise<BuiltRetrievalIndex>;
}

/** The offline default: TF-IDF cosine over chunk vectors, no network/key. */
export function createTfidfEngine(): RetrievalEngine {
  return {
    name: 'tfidf',
    async build(documents) {
      const index = buildSemanticIndex([...documents]);
      return {
        async querySemantic(query, options) {
          return querySemanticIndex(index, query, options);
        },
        async queryRanked(query, options) {
          return queryRankedChunks(index, query, options);
        },
      };
    },
  };
}

/**
 * The opt-in embedding engine. Chunks the corpus with the *same* chunker as
 * TF-IDF, embeds each chunk's text, and ranks by dense cosine.
 *
 * Two caches keep the API cost sane: a **chunk-text → vector** cache means a
 * rebuild after a single-note edit only re-embeds that note's changed chunks (it
 * is pruned to the live corpus each build to bound memory), and a bounded
 * **query → vector** cache avoids re-embedding a repeated query. Query-vector
 * caching is safe across rebuilds because a query's embedding is independent of
 * the corpus.
 */
export function createEmbeddingsEngine(embed: EmbedFn): RetrievalEngine {
  const vectorCache = new Map<string, number[]>();
  const queryCache = new Map<string, number[]>();

  async function embedQuery(query: string): Promise<number[]> {
    const cached = queryCache.get(query);
    if (cached) {
      return cached;
    }
    const [vector] = await embed([query]);
    if (queryCache.size >= 256) {
      queryCache.clear();
    }
    queryCache.set(query, vector);
    return vector;
  }

  return {
    name: 'embeddings',
    async build(documents) {
      const chunks = chunkDocuments(documents);
      const texts = chunks.map(embeddableText);

      const missing = [...new Set(texts)].filter((text) => !vectorCache.has(text));
      if (missing.length > 0) {
        const fresh = await embed(missing);
        missing.forEach((text, i) => vectorCache.set(text, fresh[i]));
      }

      // Prune the chunk-vector cache down to the live corpus so it can't grow
      // unbounded as notes churn.
      const live = new Set(texts);
      for (const key of [...vectorCache.keys()]) {
        if (!live.has(key)) {
          vectorCache.delete(key);
        }
      }

      const vectors = texts.map((text) => vectorCache.get(text) ?? []);
      const index: EmbeddingIndex = { chunks, vectors };

      return {
        async querySemantic(query, options) {
          const vector = await embedQuery(query);
          return queryEmbeddingHits(index, vector, options);
        },
        async queryRanked(query, options) {
          const vector = await embedQuery(query);
          return queryEmbeddingIndex(index, vector, options);
        },
      };
    },
  };
}

export type FallbackReason = 'build' | 'query';

/**
 * Wrap a `primary` engine so any failure degrades to `fallback` instead of
 * breaking search. A build failure (bad key, no network) rebuilds the whole
 * corpus on the fallback engine; a per-query failure (a transient embed error)
 * returns no semantic hits for that query — lexical and hybrid search, which
 * fuse the untouched full-text engine, keep working regardless. `onFallback` is
 * a hook for a log line.
 */
export function createResilientEngine(
  primary: RetrievalEngine,
  fallback: RetrievalEngine,
  onFallback?: (reason: FallbackReason, error: unknown) => void,
): RetrievalEngine {
  return {
    name: primary.name,
    async build(documents) {
      let built: BuiltRetrievalIndex;
      try {
        built = await primary.build(documents);
      } catch (error) {
        onFallback?.('build', error);
        return fallback.build(documents);
      }
      return {
        async querySemantic(query, options) {
          try {
            return await built.querySemantic(query, options);
          } catch (error) {
            onFallback?.('query', error);
            return [];
          }
        },
        async queryRanked(query, options) {
          try {
            return await built.queryRanked(query, options);
          } catch (error) {
            onFallback?.('query', error);
            return [];
          }
        },
      };
    },
  };
}

/**
 * Resolve the retrieval engine from configuration. With `embed` absent (the
 * default — `FSBRAIN_EMBEDDINGS` off or no key) this is the plain offline TF-IDF
 * engine; with an `EmbedFn` it is the embedding engine guarded by a TF-IDF
 * fallback. `resolveEmbedFn` reads the env toggle so callers don't have to.
 */
export function createRetrievalEngine(
  options: {
    embed?: EmbedFn | null;
    onFallback?: (reason: FallbackReason, error: unknown) => void;
  } = {},
): RetrievalEngine {
  const tfidf = createTfidfEngine();
  if (!options.embed) {
    return tfidf;
  }
  return createResilientEngine(createEmbeddingsEngine(options.embed), tfidf, options.onFallback);
}

/**
 * Build an `EmbedFn` from the environment, or `null` when embeddings are off.
 * The single place the env toggle is read into a live client.
 */
export function resolveEmbedFn(env: NodeJS.ProcessEnv = process.env): EmbedFn | null {
  const config = loadEmbeddingConfig(env);
  return config ? createEmbedFn(config) : null;
}
