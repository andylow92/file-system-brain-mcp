/**
 * Pure, dependency-free **note-level TF-IDF similarity** — the shared core of
 * every "how alike are these two notes?" question in the vault.
 *
 * The dream-cycle maintenance scan (`maintenance.ts` — near-duplicate notes) and
 * the skill curator (`skillCurator.ts` — near-duplicate skills) both need the
 * same thing: a normalized TF-IDF vector per note and a cosine between two of
 * them. This module is that one implementation, so the two callers can never
 * drift on the weighting (a normalized vector means the dot product *is* the
 * cosine). The chunk-level semantic engine (`semantic.ts`) keeps its own copy
 * for now — it operates on chunks, not whole notes, and sits on the hot
 * retrieval path — but it is a candidate to fold in behind the same primitives.
 */
import { parseFrontmatter } from './markdown.js';
import { tokenize } from './semantic.js';

/**
 * Build a normalized TF-IDF vector from a document's tokens. Weight is
 * `(1 + log(tf)) * idf(term)`; the vector is L2-normalized so a dot product with
 * another normalized vector is their cosine similarity.
 */
export function buildTfidfVector(
  tokens: string[],
  idf: (term: string) => number,
): Map<string, number> {
  const termFrequency = new Map<string, number>();
  for (const token of tokens) {
    termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
  }

  const vector = new Map<string, number>();
  let norm = 0;
  for (const [term, count] of termFrequency) {
    const weight = (1 + Math.log(count)) * idf(term);
    vector.set(term, weight);
    norm += weight * weight;
  }

  const magnitude = Math.sqrt(norm) || 1;
  for (const [term, weight] of vector) {
    vector.set(term, weight / magnitude);
  }
  return vector;
}

/** Cosine of two normalized vectors = their dot product (iterate the smaller). */
export function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, weight] of small) {
    const other = large.get(term);
    if (other) {
      dot += weight * other;
    }
  }
  return dot;
}

/** A pair of notes whose bodies are near-duplicates, with their cosine score. */
export interface DuplicatePair {
  /** The lexicographically-first path of the pair. */
  a: string;
  /** The lexicographically-second path of the pair. */
  b: string;
  /** Note-level TF-IDF cosine in [0, 1]. */
  score: number;
}

/**
 * Find every pair of documents whose note-level TF-IDF cosine is at or above
 * `threshold`. Bodies are tokenized (frontmatter stripped), the IDF is computed
 * once over the corpus, and each note gets one vector reused across the O(n²)
 * pairwise compare (fine for a local vault). A note with no rankable tokens is
 * never a "duplicate" of anything. Pairs are returned with `a < b` by path and
 * the list sorted for determinism.
 */
export function findDuplicatePairs(
  documents: readonly { path: string; content: string }[],
  threshold: number,
): DuplicatePair[] {
  const tokensByDoc = documents.map((doc) => tokenize(parseFrontmatter(doc.content).body));

  const documentFrequency = new Map<string, number>();
  for (const tokens of tokensByDoc) {
    for (const term of new Set(tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const total = documents.length;
  const idf = (term: string) => Math.log(1 + total / ((documentFrequency.get(term) ?? 0) + 1));
  const vectors = tokensByDoc.map((tokens) => buildTfidfVector(tokens, idf));

  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < documents.length; i += 1) {
    for (let j = i + 1; j < documents.length; j += 1) {
      if (vectors[i].size === 0 || vectors[j].size === 0) {
        continue;
      }
      const score = cosineSimilarity(vectors[i], vectors[j]);
      if (score < threshold) {
        continue;
      }
      const [a, b] = [documents[i].path, documents[j].path].sort((x, y) => x.localeCompare(y));
      pairs.push({ a, b, score });
    }
  }

  return pairs.sort((p, q) => p.a.localeCompare(q.a) || p.b.localeCompare(q.b));
}
