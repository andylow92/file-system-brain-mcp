import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, readFile, rm, writeFile as writeFsFile, mkdir } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createIntegrationStore, INTEGRATIONS_DIR, INTEGRATIONS_FILE } from './integrationStore.js';

describe('integrationStore', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'integration-store-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('serializes concurrent updates so neither patch is lost', async () => {
    const store = createIntegrationStore(root);
    // A toggle-only update racing a key update: without serialization, the
    // read-modify-write that finishes last would revert the other's field.
    await Promise.all([
      store.setRocketReach({ enabled: true }),
      store.setRocketReach({ apiKey: 'rr_secret_key_123456' }),
    ]);
    const settings = await store.getRocketReach();
    expect(settings.enabled).toBe(true);
    expect(settings.apiKey).toBe('rr_secret_key_123456');
  });

  it('writes atomically, leaving no temp file behind', async () => {
    const store = createIntegrationStore(root);
    await store.setRocketReach({ enabled: true, apiKey: 'rr_secret_key_123456' });
    const entries = await readdir(path.join(root, INTEGRATIONS_DIR));
    expect(entries).toContain(INTEGRATIONS_FILE);
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const raw = await readFile(path.join(root, INTEGRATIONS_DIR, INTEGRATIONS_FILE), 'utf8');
    expect(JSON.parse(raw).rocketreach).toMatchObject({ enabled: true });
  });

  it('treats a corrupt settings file as empty instead of bricking the integration', async () => {
    await mkdir(path.join(root, INTEGRATIONS_DIR), { recursive: true });
    await writeFsFile(path.join(root, INTEGRATIONS_DIR, INTEGRATIONS_FILE), '{not json');
    const store = createIntegrationStore(root);
    await expect(store.getRocketReach()).resolves.toEqual({ enabled: false });
  });
});
