import { describe, expect, it, vi } from 'vitest';

import type { EmbedFn } from '../embeddings/client.js';
import { loadEmbeddingConfig } from '../embeddings/config.js';
import {
  createEmbeddingsEngine,
  createResilientEngine,
  createRetrievalEngine,
  createTfidfEngine,
  resolveEmbedFn,
} from '../index/retrievalEngine.js';

const DOCS = [
  { path: 'cats.md', content: '# Cats\nfelines purr and hunt' },
  { path: 'finance.md', content: '# Finance\nquarterly revenue and profit' },
];

// A tiny deterministic "embedding" space: axis 0 = cats, axis 1 = finance.
// Only the exact strings the corpus and queries produce are mapped; everything
// else embeds to the zero vector.
function makeMockEmbed(): { embed: EmbedFn; calls: string[][] } {
  const table: Record<string, number[]> = {
    'Cats\nfelines purr and hunt': [1, 0],
    'Finance\nquarterly revenue and profit': [0, 1],
    kitten: [1, 0],
    earnings: [0, 1],
  };
  const calls: string[][] = [];
  const embed: EmbedFn = async (texts) => {
    calls.push(texts);
    return texts.map((text) => table[text] ?? [0, 0]);
  };
  return { embed, calls };
}

describe('createTfidfEngine (offline default)', () => {
  it('ranks lexically and identifies as tfidf', async () => {
    const engine = createTfidfEngine();
    expect(engine.name).toBe('tfidf');
    const index = await engine.build(DOCS);
    const hits = await index.querySemantic('feline', {});
    expect(hits[0]?.path).toBe('cats.md');
  });
});

describe('createEmbeddingsEngine', () => {
  it('ranks by embedding similarity, not word overlap', async () => {
    const { embed } = makeMockEmbed();
    const engine = createEmbeddingsEngine(embed);
    expect(engine.name).toBe('embeddings');
    const index = await engine.build(DOCS);

    // "kitten" shares no tokens with the cats note, yet embeds near it.
    const ranked = await index.queryRanked('kitten', {});
    expect(ranked[0]?.path).toBe('cats.md');
    const hits = await index.querySemantic('earnings', {});
    expect(hits[0]?.path).toBe('finance.md');
  });

  it('caches chunk vectors across rebuilds and queries across calls', async () => {
    const { embed, calls } = makeMockEmbed();
    const engine = createEmbeddingsEngine(embed);

    const first = await engine.build(DOCS);
    const chunkEmbedCalls = calls.length; // one batch for the 2 chunk texts
    expect(chunkEmbedCalls).toBe(1);

    await first.queryRanked('kitten', {});
    expect(calls.length).toBe(2); // + one query embed

    await first.queryRanked('kitten', {}); // repeat → served from query cache
    expect(calls.length).toBe(2);

    // Rebuild the same corpus → no chunk re-embedding (all cached).
    await engine.build(DOCS);
    expect(calls.length).toBe(2);
  });
});

describe('createResilientEngine', () => {
  it('falls back to TF-IDF when the primary build throws', async () => {
    const onFallback = vi.fn();
    const failing = {
      name: 'embeddings' as const,
      build: () => Promise.reject(new Error('no network')),
    };
    const engine = createResilientEngine(failing, createTfidfEngine(), onFallback);

    const index = await engine.build(DOCS);
    const hits = await index.querySemantic('feline', {}); // TF-IDF still answers
    expect(hits[0]?.path).toBe('cats.md');
    expect(onFallback).toHaveBeenCalledWith('build', expect.any(Error));
  });

  it('returns no semantic hits (not a throw) when a per-query embed fails', async () => {
    const onFallback = vi.fn();
    const queryFailEmbed: EmbedFn = async (texts) => {
      // Succeed for the multi-text chunk batch at build time; fail single-text
      // query embeds.
      if (texts.length === 1) {
        throw new Error('transient');
      }
      return texts.map(() => [1, 0]);
    };
    const engine = createResilientEngine(
      createEmbeddingsEngine(queryFailEmbed),
      createTfidfEngine(),
      onFallback,
    );

    const index = await engine.build(DOCS);
    await expect(index.queryRanked('kitten', {})).resolves.toEqual([]);
    expect(onFallback).toHaveBeenCalledWith('query', expect.any(Error));
  });
});

describe('createRetrievalEngine (env-driven selection)', () => {
  it('is plain TF-IDF when no embed function is provided', () => {
    expect(createRetrievalEngine().name).toBe('tfidf');
    expect(createRetrievalEngine({ embed: null }).name).toBe('tfidf');
  });

  it('uses embeddings (guarded) when an embed function is provided', async () => {
    const { embed } = makeMockEmbed();
    const engine = createRetrievalEngine({ embed });
    expect(engine.name).toBe('embeddings');
    const index = await engine.build(DOCS);
    expect((await index.queryRanked('kitten', {}))[0]?.path).toBe('cats.md');
  });
});

describe('loadEmbeddingConfig / resolveEmbedFn (the toggle)', () => {
  it('is off by default and off when the flag is unset', () => {
    expect(loadEmbeddingConfig({})).toBeNull();
    expect(loadEmbeddingConfig({ EMBEDDINGS_API_KEY: 'k' })).toBeNull();
    expect(resolveEmbedFn({})).toBeNull();
  });

  it('stays off when enabled but no key is present', () => {
    expect(loadEmbeddingConfig({ FSBRAIN_EMBEDDINGS: 'on' })).toBeNull();
  });

  it('turns on with a flag + key, falling back to OPENROUTER_API_KEY', () => {
    const viaDedicated = loadEmbeddingConfig({
      FSBRAIN_EMBEDDINGS: '1',
      EMBEDDINGS_API_KEY: 'sk-embed',
    });
    expect(viaDedicated).toMatchObject({ apiKey: 'sk-embed' });

    const viaOpenrouter = loadEmbeddingConfig({
      FSBRAIN_EMBEDDINGS: 'true',
      OPENROUTER_API_KEY: 'sk-or',
    });
    expect(viaOpenrouter).toMatchObject({ apiKey: 'sk-or' });
    expect(resolveEmbedFn({ FSBRAIN_EMBEDDINGS: 'yes', EMBEDDINGS_API_KEY: 'k' })).toBeTypeOf(
      'function',
    );
  });

  it('honours model / url / batch-size overrides', () => {
    const config = loadEmbeddingConfig({
      FSBRAIN_EMBEDDINGS: 'on',
      EMBEDDINGS_API_KEY: 'k',
      EMBEDDINGS_MODEL: 'my/model',
      EMBEDDINGS_URL: 'https://example.test/v1/embeddings',
      EMBEDDINGS_BATCH_SIZE: '8',
    });
    expect(config).toMatchObject({
      model: 'my/model',
      url: 'https://example.test/v1/embeddings',
      batchSize: 8,
    });
  });
});
