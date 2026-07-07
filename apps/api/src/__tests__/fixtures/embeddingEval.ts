/**
 * A **deterministic, offline** fixture for evaluating the embedding retrieval
 * engine (backlog #13) inside `npm test`, without a real provider.
 *
 * A real embedding model can't run in CI (network, key, cost, non-determinism),
 * yet the whole point of embeddings — retrieving passages that share *meaning*
 * but not *words* — is exactly what a bag-of-words engine (TF-IDF) cannot do, so
 * a token-overlap eval would prove nothing. This fixture bridges that gap with a
 * **controlled semantic space**: a tiny `conceptEmbed` test double that projects
 * text onto a handful of concept axes via a curated synonym lexicon. It is *not*
 * a model — it just lets us build cases where the query and its expected note
 * share a concept but **zero tokens**, so the embedding engine retrieves them
 * and TF-IDF provably cannot. That validates the engine's pipeline (chunk →
 * embed → cosine → dedupe → recall/MRR) and the semantic-over-lexical property
 * on inputs we fully control.
 *
 * For a real-provider check, see the provider-gated live eval in
 * `embeddingEval.test.ts`.
 */
import { tokenize } from '@repo/shared';

import type { CorpusNote } from './retrievalCorpus.js';

export { type CorpusNote } from './retrievalCorpus.js';

/** k for recall@k / MRR@k in this eval. */
export const CONCEPT_K = 3;

/**
 * Concept axes, each seeded with related surface words. The embedder aligns
 * stemming with the corpus/queries by running every seed through the same
 * `tokenize` the engines use, so `felines`/`feline` and `pruning`/`prune`
 * collapse together.
 */
const CONCEPT_SEEDS: Record<string, string[]> = {
  feline: [
    'cat',
    'cats',
    'feline',
    'felines',
    'kitten',
    'kittens',
    'purr',
    'purring',
    'tabby',
    'whiskers',
    'paws',
  ],
  finance: ['revenue', 'profit', 'earnings', 'income', 'quarterly', 'annual', 'fiscal', 'dividend'],
  astronomy: [
    'star',
    'stars',
    'stellar',
    'galaxy',
    'nebula',
    'cosmos',
    'cosmic',
    'giant',
    'supernova',
  ],
  gardening: ['garden', 'soil', 'compost', 'seedling', 'prune', 'pruning', 'mulch', 'perennial'],
};

/** Axis order is fixed so every produced vector is aligned. */
const AXES = Object.keys(CONCEPT_SEEDS);

/** Pre-stem each axis's seed words into a lookup set. */
const AXIS_TERMS: Array<Set<string>> = AXES.map(
  (axis) => new Set(tokenize(CONCEPT_SEEDS[axis].join(' '))),
);

/**
 * The deterministic "embedding": count how many of a text's tokens fall on each
 * concept axis. Two texts on the same axis point the same way (cosine 1) even
 * with no shared words; unrelated text yields the zero vector (filtered out by
 * the engine's minScore). Purely a function of its input — no model, no I/O.
 *
 * `async` to satisfy the engine's `EmbedFn` contract (a real provider is
 * network-bound); the computation itself is synchronous and deterministic.
 */
export function conceptEmbed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((text) => {
      const tokens = tokenize(text);
      return AXIS_TERMS.map((terms) =>
        tokens.reduce((n, token) => n + (terms.has(token) ? 1 : 0), 0),
      );
    }),
  );
}

/**
 * The corpus: one note per concept, worded so its concept tokens differ from
 * the query's (below), plus two distractors with no concept vocabulary at all.
 */
export const CONCEPT_CORPUS: CorpusNote[] = [
  {
    path: 'pets/cats.md',
    content: '# Felines\n\nA purring tabby stalks rodents through the tall grass at dusk.',
  },
  {
    path: 'work/earnings.md',
    content: '# Quarterly results\n\nRevenue beat every profit forecast the board set.',
  },
  {
    path: 'science/stars.md',
    content:
      '# Stellar forges\n\nInside a red giant, stellar fusion welds light nuclei into heavier ones.',
  },
  {
    path: 'home/garden.md',
    content: '# Beds\n\nCompost enriches the soil so the perennial roots settle before frost.',
  },
  // Distractors: no concept vocabulary, so they embed to the zero vector.
  {
    path: 'misc/commute.md',
    content: '# Commute\n\nThe morning train was delayed again by signalling works downtown.',
  },
  {
    path: 'misc/paint.md',
    content: '# Paint\n\nWe repainted the hallway a warmer shade over the long weekend.',
  },
];

/**
 * Golden cases: each query is a paraphrase whose tokens do **not** appear in the
 * expected note, only its concept does. A bag-of-words engine scores these at
 * zero; the embedding engine retrieves them.
 */
export const CONCEPT_CASES: Array<{
  id: string;
  query: string;
  expected: string[];
  description?: string;
}> = [
  {
    id: 'feline-paraphrase',
    query: 'kitten whiskers behaviour',
    expected: ['pets/cats.md'],
    description: 'feline concept; shares no tokens with "purring tabby stalks rodents"',
  },
  {
    id: 'finance-paraphrase',
    query: 'annual income statement',
    expected: ['work/earnings.md'],
    description: 'finance concept; no overlap with "revenue beat profit forecast"',
  },
  {
    id: 'astronomy-paraphrase',
    query: 'galaxy nebula cosmos',
    expected: ['science/stars.md'],
    description: 'astronomy concept; no overlap with "stellar fusion welds nuclei"',
  },
  {
    id: 'gardening-paraphrase',
    query: 'mulch pruning seedlings',
    expected: ['home/garden.md'],
    description: 'gardening concept; no overlap with "compost enriches soil perennial"',
  },
];
