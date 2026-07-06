import { describe, expect, it } from 'vitest';

import {
  chunkDocuments,
  cosineDense,
  embeddableText,
  queryEmbeddingHits,
  queryEmbeddingIndex,
  type EmbeddingIndex,
} from '@repo/shared';

describe('cosineDense', () => {
  it('is 1 for identical directions and 0 for orthogonal ones', () => {
    expect(cosineDense([1, 0, 0], [2, 0, 0])).toBeCloseTo(1, 6);
    expect(cosineDense([1, 0], [0, 1])).toBe(0);
  });

  it('guards against zero-magnitude and mismatched-dimension inputs', () => {
    expect(cosineDense([0, 0], [1, 1])).toBe(0);
    expect(cosineDense([], [])).toBe(0);
    expect(cosineDense([1, 2, 3], [1, 2])).toBe(0);
  });

  it('does not require pre-normalized vectors', () => {
    // Same direction, very different magnitudes → still 1.
    expect(cosineDense([3, 4], [30, 40])).toBeCloseTo(1, 6);
  });
});

describe('chunkDocuments / embeddableText', () => {
  it('flattens a corpus into chunks and prepends the heading for embedding', () => {
    const chunks = chunkDocuments([
      { path: 'a.md', content: '# Title\nbody one' },
      { path: 'b.md', content: 'plain body' },
    ]);
    expect(chunks.map((c) => c.path)).toEqual(['a.md', 'b.md']);
    expect(embeddableText(chunks[0])).toBe('Title\nbody one');
    expect(embeddableText(chunks[1])).toBe('plain body');
  });
});

describe('queryEmbeddingIndex', () => {
  // A tiny 2-D "embedding" space: axis 0 = cats, axis 1 = finance.
  const index: EmbeddingIndex = {
    chunks: [
      { path: 'cats.md', index: 0, text: 'felines purr' },
      { path: 'money.md', index: 0, text: 'quarterly revenue' },
    ],
    vectors: [
      [1, 0],
      [0, 1],
    ],
  };

  it('ranks the semantically closest chunk first', () => {
    const ranked = queryEmbeddingIndex(index, [0.9, 0.1]);
    expect(ranked[0].path).toBe('cats.md');
    expect(ranked[0].score).toBeGreaterThan(ranked[1]?.score ?? -1);
  });

  it('mirrors the TF-IDF RankedChunk shape (text, chunkIndex, 4dp score)', () => {
    const [top] = queryEmbeddingIndex(index, [1, 0]);
    expect(top).toMatchObject({ path: 'cats.md', text: 'felines purr', chunkIndex: 0 });
    expect(top.score).toBe(1);
  });

  it('honours limit and minScore, and returns [] for an empty query vector', () => {
    expect(queryEmbeddingIndex(index, [1, 1], { limit: 1 })).toHaveLength(1);
    // Orthogonal to everything → filtered by the default minScore.
    expect(queryEmbeddingIndex(index, [0, 0])).toEqual([]);
    expect(queryEmbeddingIndex(index, [])).toEqual([]);
  });

  it('projects to SemanticHit with a trimmed snippet', () => {
    const [hit] = queryEmbeddingHits(index, [1, 0]);
    expect(hit).toMatchObject({ path: 'cats.md', snippet: 'felines purr', chunkIndex: 0 });
  });
});
