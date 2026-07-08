import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEmbedFn } from '../embeddings/client.js';
import type { EmbeddingConfig } from '../embeddings/config.js';

const config: EmbeddingConfig = {
  url: 'https://provider.test/v1/embeddings',
  apiKey: 'test-key',
  model: 'test-model',
  batchSize: 2,
};

/** Stub `fetch` to echo one unit vector per input text, recording each request body. */
function stubFetch(): { inputs: string[][] } {
  const inputs: string[][] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { input: string[] };
    inputs.push(body.input);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: body.input.map((_text, index) => ({ index, embedding: [index + 1] })),
      }),
    } as Response;
  });
  return { inputs };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createEmbedFn', () => {
  it('substitutes a space for empty / whitespace-only inputs, preserving parallel length', async () => {
    const { inputs } = stubFetch();
    const embed = createEmbedFn(config);

    const vectors = await embed(['hello', '', '   ']);

    // Every input still yields a vector, in order.
    expect(vectors).toHaveLength(3);
    // The blank inputs were sent as a single space, never an empty string.
    const sent = inputs.flat();
    expect(sent).toEqual(['hello', ' ', ' ']);
    expect(sent).not.toContain('');
  });

  it('splits inputs into batchSize requests and concatenates in input order', async () => {
    const { inputs } = stubFetch();
    const embed = createEmbedFn(config);

    const vectors = await embed(['a', 'b', 'c', 'd', 'e']);

    // batchSize 2 → batches of [a,b], [c,d], [e].
    expect(inputs).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(vectors).toHaveLength(5);
  });
});
