/**
 * Retrieval eval for the embedding engine (backlog #13, extending the harness
 * from #20).
 *
 * Two layers:
 *
 * 1. **Deterministic, offline** (always runs). A controlled concept-embedder
 *    (`conceptEmbed`) drives the real embedding engine over a fixture where each
 *    query shares a *concept* but no *tokens* with its expected note. This pins
 *    the engine's pipeline (chunk → embed → cosine → dedupe → recall/MRR) and
 *    proves the semantic-over-lexical win: embeddings retrieve every case, TF-IDF
 *    — a bag-of-words ranker — retrieves none of them.
 *
 * 2. **Provider-gated live** (opt-in). When `FSBRAIN_EMBEDDINGS` is on with a
 *    key, the golden `retrievalCorpus` fixture is run against a real
 *    `/api/semantic-search` so you can measure the actual provider's recall;
 *    skipped in CI, where no key is configured.
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatEvalReport,
  scoreEvalCase,
  summarizeEval,
  type EvalSummary,
  type RankQueryOptions,
} from '@repo/shared';

import { loadEmbeddingConfig } from '../embeddings/config.js';
import { createEmbeddingsEngine, createTfidfEngine } from '../index/retrievalEngine.js';
import {
  CONCEPT_CASES,
  CONCEPT_CORPUS,
  CONCEPT_K,
  conceptEmbed,
} from './fixtures/embeddingEval.js';
import { EVAL_CASES, EVAL_CORPUS, EVAL_K } from './fixtures/retrievalCorpus.js';

const FETCH_LIMIT = 25;

describe('embedding retrieval eval — deterministic (offline concept embedder)', () => {
  /** Run every concept case against a built index and summarize. */
  async function runEval(
    query: (q: string, options: RankQueryOptions) => Promise<{ path: string }[]>,
  ): Promise<EvalSummary> {
    const results = [];
    for (const evalCase of CONCEPT_CASES) {
      const hits = await query(evalCase.query, { limit: FETCH_LIMIT });
      results.push(
        scoreEvalCase(
          evalCase,
          hits.map((h) => h.path),
          CONCEPT_K,
        ),
      );
    }
    return summarizeEval(results, CONCEPT_K);
  }

  it('embeddings retrieve every paraphrase case; TF-IDF retrieves none', async () => {
    const embedIndex = await createEmbeddingsEngine(conceptEmbed).build(CONCEPT_CORPUS);
    const tfidfIndex = await createTfidfEngine().build(CONCEPT_CORPUS);

    const embed = await runEval((q, o) => embedIndex.querySemantic(q, o));
    const tfidf = await runEval((q, o) => tfidfIndex.querySemantic(q, o));

    // The embedding engine gets every concept-matched note (recall 1, no misses)
    // and ranks it first (MRR 1) — these queries share meaning, not words.
    expect(embed.failures, formatEvalReport('embeddings', embed)).toEqual([]);
    expect(embed.meanRecall).toBe(1);
    expect(embed.meanReciprocalRank).toBe(1);

    // A bag-of-words ranker can't bridge the vocabulary gap: zero shared tokens
    // means zero score, so it retrieves none of them. This is the whole point of
    // adding embeddings — and the guard that the engine really is embedding-based
    // rather than silently falling through to lexical.
    expect(tfidf.meanRecall).toBe(0);
    expect(embed.meanRecall).toBeGreaterThan(tfidf.meanRecall);
  });
});

// Only runs when a provider is actually configured; skipped in CI.
const liveConfig = loadEmbeddingConfig();
const describeLive = liveConfig ? describe : describe.skip;

describeLive('embedding retrieval eval — live provider (opt-in)', () => {
  let contentRoot = '';
  let baseUrl = '';
  let server: http.Server | undefined;

  async function runEval(endpoint: string): Promise<EvalSummary> {
    const results = [];
    for (const evalCase of EVAL_CASES) {
      const query = encodeURIComponent(evalCase.query);
      const response = await fetch(`${baseUrl}${endpoint}?q=${query}&limit=${FETCH_LIMIT}`);
      const body = (await response.json()) as { data?: { path: string }[] };
      expect(response.status).toBe(200);
      results.push(
        scoreEvalCase(
          evalCase,
          (body.data ?? []).map((h) => h.path),
          EVAL_K,
        ),
      );
    }
    return summarizeEval(results, EVAL_K);
  }

  beforeAll(async () => {
    contentRoot = await mkdtemp(path.join(os.tmpdir(), 'embedding-eval-live-'));
    process.env.CONTENT_ROOT = contentRoot;

    const { createServer } = await import('../server.js');
    server = createServer();
    await new Promise<void>((resolve) => server!.listen(0, () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to determine server address');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    for (const note of EVAL_CORPUS) {
      const response = await fetch(`${baseUrl}/api/file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(note),
      });
      expect(response.status).toBe(201);
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
    if (contentRoot) {
      await rm(contentRoot, { recursive: true, force: true });
    }
  });

  it('a real embedding provider clears the semantic recall floor', async () => {
    const summary = await runEval('/api/semantic-search');
    // Embeddings should be at least as strong as the TF-IDF floor on this
    // fixture; raise this once a provider's measured score is known.
    expect(
      summary.meanRecall,
      formatEvalReport('embeddings(live)', summary),
    ).toBeGreaterThanOrEqual(0.85);
  });
});
