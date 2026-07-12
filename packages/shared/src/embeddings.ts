/**
 * Pure, dependency-free ranking over **dense embedding vectors**.
 *
 * This is the offline half of the optional embedding engine: given chunks and
 * their pre-computed embedding vectors (produced elsewhere by a provider — the
 * only part that needs a network/key), it ranks them against a query vector by
 * cosine similarity and projects the results to the exact same `RankedChunk` /
 * `SemanticHit` shapes the TF-IDF engine returns. So a caller that swaps the
 * TF-IDF ranker for embeddings sees an identical `documents → ranked` contract.
 *
 * Deliberately no I/O here: embedding text into vectors is done by the API layer
 * (`apps/api/src/embeddings/`), which keeps this module fully deterministic,
 * offline, and testable — matching the repo's "pure helpers in @repo/shared"
 * constraint.
 */
import { chunkNote } from './semantic.js';
import type {
  NoteChunk,
  RankQueryOptions,
  RankedChunk,
  SemanticDocument,
  SemanticHit,
} from './semantic.js';

/**
 * A pre-built ranking index over embedded chunks: every note is chunked once and
 * each chunk carries its dense embedding vector (parallel arrays). Build it once
 * (embedding is the expensive part) and query it many times — only the query
 * vector is embedded per call.
 */
export interface EmbeddingIndex {
  chunks: NoteChunk[];
  /** Per-chunk embedding vector, parallel to `chunks`. */
  vectors: number[][];
}

/**
 * Chunk a corpus into the flat list of `NoteChunk`s that need embedding, using
 * the **same** chunker as the TF-IDF engine (`chunkNote`) so both engines index
 * identical passages. The heading is prepended to the text an engine embeds (a
 * strong relevance signal) while `chunk.text` stays clean for display.
 */
export function chunkDocuments(
  documents: readonly SemanticDocument[],
  chunkSize?: number,
): NoteChunk[] {
  const chunks: NoteChunk[] = [];
  for (const doc of documents) {
    chunks.push(...chunkNote(doc.path, doc.content, chunkSize));
  }
  return chunks;
}

/** The text an engine should embed for a chunk (heading + body, mirroring TF-IDF). */
export function embeddableText(chunk: NoteChunk): string {
  return chunk.heading ? `${chunk.heading}\n${chunk.text}` : chunk.text;
}

/**
 * Cosine similarity of two dense vectors, guarded against zero-magnitude inputs.
 * Vectors need not be pre-normalized. Returns 0 when either is empty/degenerate
 * or the dimensions differ.
 */
export function cosineDense(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) {
    return 0;
  }
  return dot / magnitude;
}

/**
 * Rank an `EmbeddingIndex`'s chunks against a query vector, returning full chunk
 * text. Mirrors `queryRankedChunks` (TF-IDF): same options, same `RankedChunk`
 * shape, same tie-break (path order) and 4dp score rounding, so the two engines
 * are drop-in interchangeable behind the `VaultIndex`.
 */
export function queryEmbeddingIndex(
  index: EmbeddingIndex,
  queryVector: readonly number[],
  options: RankQueryOptions = {},
): RankedChunk[] {
  if (queryVector.length === 0 || index.chunks.length === 0) {
    return [];
  }

  const scored = index.chunks.map((chunk, i) => ({
    chunk,
    score: cosineDense(queryVector, index.vectors[i] ?? []),
  }));

  const limit = options.limit ?? 10;
  const minScore = options.minScore ?? 0.01;

  return scored
    .filter((entry) => entry.score > minScore)
    .sort((a, b) => b.score - a.score || a.chunk.path.localeCompare(b.chunk.path))
    .slice(0, limit)
    .map((entry) => ({
      path: entry.chunk.path,
      ...(entry.chunk.heading ? { heading: entry.chunk.heading } : {}),
      text: entry.chunk.text,
      score: Number(entry.score.toFixed(4)),
      chunkIndex: entry.chunk.index,
    }));
}

/** Project embedding-ranked chunks to `SemanticHit` (trimmed display snippet). */
export function queryEmbeddingHits(
  index: EmbeddingIndex,
  queryVector: readonly number[],
  options: RankQueryOptions = {},
): SemanticHit[] {
  return queryEmbeddingIndex(index, queryVector, options).map((chunk) => ({
    path: chunk.path,
    ...(chunk.heading ? { heading: chunk.heading } : {}),
    chunkIndex: chunk.chunkIndex,
    score: chunk.score,
    snippet: chunk.text.replace(/\s+/g, ' ').trim().slice(0, 200),
  }));
}
