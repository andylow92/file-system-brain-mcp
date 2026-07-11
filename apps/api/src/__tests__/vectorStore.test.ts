import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createFileVectorStore,
  EMBEDDINGS_DIR,
  EMBEDDINGS_FILE,
} from '../embeddings/vectorStore.js';

describe('createFileVectorStore', () => {
  let root: string;
  const file = () => path.join(root, EMBEDDINGS_DIR, EMBEDDINGS_FILE);

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vector-store-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips vectors for the same model', async () => {
    const store = createFileVectorStore(root);
    const vectors = new Map<string, number[]>([
      ['h1', [0.1, 0.2, 0.3]],
      ['h2', [1, 0, -1]],
    ]);
    await store.save('model-a', vectors);

    const loaded = await store.load('model-a');
    expect(loaded.get('h1')).toEqual([0.1, 0.2, 0.3]);
    expect(loaded.get('h2')).toEqual([1, 0, -1]);
    expect(loaded.size).toBe(2);
  });

  it('returns empty when no file exists yet (cold start)', async () => {
    const store = createFileVectorStore(root);
    expect((await store.load('model-a')).size).toBe(0);
  });

  it('discards everything when the model differs (incompatible vector space)', async () => {
    const store = createFileVectorStore(root);
    await store.save('model-a', new Map([['h1', [1, 2, 3]]]));
    expect((await store.load('model-b')).size).toBe(0);
  });

  it('tolerates a corrupt or truncated file, loading as empty', async () => {
    const store = createFileVectorStore(root);
    await store.save('model-a', new Map([['h1', [1, 2, 3]]]));
    await writeFile(file(), '{ this is not valid json', 'utf8');
    expect((await store.load('model-a')).size).toBe(0);
  });

  it('drops malformed vector entries but keeps well-formed ones', async () => {
    await mkdir(path.dirname(file()), { recursive: true });
    await writeFile(
      file(),
      JSON.stringify({
        version: 1,
        model: 'model-a',
        vectors: { good: [1, 2], bad: ['x', 2], alsoBad: 5 },
      }),
      'utf8',
    );
    const store = createFileVectorStore(root);
    const loaded = await store.load('model-a');
    expect(loaded.get('good')).toEqual([1, 2]);
    expect(loaded.has('bad')).toBe(false);
    expect(loaded.has('alsoBad')).toBe(false);
  });

  it('overwrites atomically and leaves no temp file behind', async () => {
    const store = createFileVectorStore(root);
    await store.save('model-a', new Map([['h1', [1]]]));
    await store.save('model-a', new Map([['h2', [2]]]));
    const loaded = await store.load('model-a');
    expect(loaded.has('h1')).toBe(false);
    expect(loaded.get('h2')).toEqual([2]);
    // The atomic temp file must not linger.
    await expect(readFile(`${file()}.tmp`, 'utf8')).rejects.toThrow();
  });
});
