import { describe, expect, it, vi } from 'vitest';

import type { EmbedFn } from '../embeddings/client.js';
import { isEmbeddingsRequested, loadEmbeddingConfig } from '../embeddings/config.js';
import type { VectorStore } from '../embeddings/vectorStore.js';
import {
  createEmbeddingsEngine,
  createResilientEngine,
  createRetrievalEngine,
  createTfidfEngine,
  resolveEmbedFn,
} from '../index/retrievalEngine.js';

/** An in-memory VectorStore that survives across "restarts" (new engine
 * instances) and records how many times it was saved. */
function makeMemoryStore(): VectorStore & { readonly saves: number } {
  let saved: { model: string; vectors: Map<string, number[]> } | null = null;
  let saves = 0;
  return {
    get saves() {
      return saves;
    },
    async load(model) {
      return saved && saved.model === model ? new Map(saved.vectors) : new Map();
    },
    async save(model, vectors) {
      saves += 1;
      saved = { model, vectors: new Map(vectors) };
    },
  };
}

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

describe('createEmbeddingsEngine persistence', () => {
  it('seeds from the store so a restart re-embeds nothing unchanged', async () => {
    const store = makeMemoryStore();

    // First "process": embeds the 2 chunks and persists them.
    const first = makeMockEmbed();
    const engineA = createEmbeddingsEngine(first.embed, { store, model: 'm1' });
    await engineA.build(DOCS);
    expect(first.calls).toHaveLength(1); // one chunk-embedding batch
    expect(store.saves).toBe(1);

    // Second "process": a fresh engine over the same store must not re-embed.
    const second = makeMockEmbed();
    const engineB = createEmbeddingsEngine(second.embed, { store, model: 'm1' });
    const index = await engineB.build(DOCS);
    expect(second.calls).toHaveLength(0); // seeded entirely from the store
    // ...and still ranks correctly off the seeded vectors.
    expect((await index.queryRanked('kitten', {}))[0]?.path).toBe('cats.md');
  });

  it('re-embeds when the model changes (incompatible vectors)', async () => {
    const store = makeMemoryStore();
    const first = makeMockEmbed();
    await createEmbeddingsEngine(first.embed, { store, model: 'm1' }).build(DOCS);

    const second = makeMockEmbed();
    await createEmbeddingsEngine(second.embed, { store, model: 'm2' }).build(DOCS);
    expect(second.calls).toHaveLength(1); // model mismatch → nothing seeded
  });

  it('does not write to the store on a no-op rebuild', async () => {
    const store = makeMemoryStore();
    const { embed } = makeMockEmbed();
    const engine = createEmbeddingsEngine(embed, { store, model: 'm1' });
    await engine.build(DOCS);
    expect(store.saves).toBe(1);
    await engine.build(DOCS); // same corpus, nothing changed
    expect(store.saves).toBe(1);
  });

  it('never fails a build when the store throws', async () => {
    const flakyStore: VectorStore = {
      load: () => Promise.reject(new Error('read fail')),
      save: () => Promise.reject(new Error('write fail')),
    };
    const { embed } = makeMockEmbed();
    const engine = createEmbeddingsEngine(embed, { store: flakyStore, model: 'm1' });
    const index = await engine.build(DOCS);
    expect((await index.queryRanked('kitten', {}))[0]?.path).toBe('cats.md');
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

  it('degrades a failing per-query embed to the fallback engine (lexical, not empty)', async () => {
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
    // A lexical query still resolves via the TF-IDF fallback rather than [].
    const ranked = await index.queryRanked('feline', {});
    expect(ranked[0]?.path).toBe('cats.md');
    expect(onFallback).toHaveBeenCalledWith('query', expect.any(Error));
  });

  it('returns [] only when the fallback also cannot answer the query', async () => {
    const queryFailEmbed: EmbedFn = async (texts) => {
      if (texts.length === 1) {
        throw new Error('transient');
      }
      return texts.map(() => [1, 0]);
    };
    const engine = createResilientEngine(
      createEmbeddingsEngine(queryFailEmbed),
      createTfidfEngine(),
    );
    const index = await engine.build(DOCS);
    // No lexical overlap with any note → TF-IDF fallback also finds nothing.
    await expect(index.queryRanked('zzzznomatch', {})).resolves.toEqual([]);
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

  it('isEmbeddingsRequested reflects the flag regardless of key (for the misconfig warning)', () => {
    expect(isEmbeddingsRequested({})).toBe(false);
    expect(isEmbeddingsRequested({ FSBRAIN_EMBEDDINGS: 'on' })).toBe(true);
    expect(isEmbeddingsRequested({ FSBRAIN_EMBEDDINGS: 'off' })).toBe(false);
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
