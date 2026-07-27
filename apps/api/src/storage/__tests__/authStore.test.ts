import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthConfigError, createAuthStore } from '../authStore.js';

const INLINE_JWKS = JSON.stringify({ keys: [{ kty: 'RSA', n: 'x', e: 'AQAB' }] });

describe('authStore', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'auth-store-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('defaults to disabled/open with no file on disk', async () => {
    const store = createAuthStore(root);
    const settings = await store.getAuth();
    expect(settings).toEqual({
      enabled: false,
      audience: 'fsbrain',
      allowLoopback: true,
      defaultAccess: 'readwrite',
      agents: [],
    });
  });

  it('applies patch semantics: untouched fields survive later updates', async () => {
    const store = createAuthStore(root);
    await store.setAuth({ trustDomain: 'example.org', jwks: { inline: INLINE_JWKS } });
    await store.setAuth({ enabled: true });
    const settings = await store.getAuth();
    expect(settings.enabled).toBe(true);
    expect(settings.trustDomain).toBe('example.org');
    expect(settings.jwks?.inline).toBe(INLINE_JWKS);

    await store.setAuth({ allowLoopback: false });
    const after = await store.getAuth();
    expect(after.enabled).toBe(true);
    expect(after.allowLoopback).toBe(false);
  });

  it('refuses to enable without a trust domain', async () => {
    const store = createAuthStore(root);
    await expect(store.setAuth({ enabled: true })).rejects.toBeInstanceOf(AuthConfigError);
  });

  it('rejects malformed trust domains and out-of-domain agent rules', async () => {
    const store = createAuthStore(root);
    await expect(store.setAuth({ trustDomain: 'Bad Domain!' })).rejects.toBeInstanceOf(
      AuthConfigError,
    );
    await store.setAuth({ trustDomain: 'example.org' });
    await expect(
      store.setAuth({
        agents: [{ id: 'spiffe://other.org/agent/x', match: 'exact', access: 'read' }],
      }),
    ).rejects.toBeInstanceOf(AuthConfigError);
    await expect(
      store.setAuth({
        agents: [{ id: 'not-a-spiffe-id', match: 'exact', access: 'read' }],
      }),
    ).rejects.toBeInstanceOf(AuthConfigError);
  });

  it('validates JWKS sources: exactly one, well-formed', async () => {
    const store = createAuthStore(root);
    await expect(
      store.setAuth({ jwks: { inline: INLINE_JWKS, url: 'https://x.test/keys' } }),
    ).rejects.toBeInstanceOf(AuthConfigError);
    await expect(store.setAuth({ jwks: { inline: 'not json' } })).rejects.toBeInstanceOf(
      AuthConfigError,
    );
    await expect(store.setAuth({ jwks: { inline: '{"keys":[]}' } })).rejects.toBeInstanceOf(
      AuthConfigError,
    );
    await expect(store.setAuth({ jwks: { file: 'relative/path.json' } })).rejects.toBeInstanceOf(
      AuthConfigError,
    );
    await expect(store.setAuth({ jwks: { url: 'ftp://nope' } })).rejects.toBeInstanceOf(
      AuthConfigError,
    );
    const ok = await store.setAuth({ jwks: { url: 'https://spire.example.org/keys' } });
    expect(ok.jwks).toEqual({ url: 'https://spire.example.org/keys' });
  });

  it('writes atomically with owner-only permissions and seeds .fsbrain/.gitignore', async () => {
    const store = createAuthStore(root);
    await store.setAuth({ trustDomain: 'example.org', enabled: true });
    const file = path.join(root, '.fsbrain', 'auth.json');
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
    const entries = await readdir(path.join(root, '.fsbrain'));
    expect(entries).not.toContain('auth.json.tmp');
    expect((await readFile(path.join(root, '.fsbrain', '.gitignore'), 'utf8')).trim()).toBe('*');
  });

  it('treats a corrupt file as defaults instead of locking the vault', async () => {
    const store = createAuthStore(root);
    await store.setAuth({ trustDomain: 'example.org', enabled: true });
    await writeFile(path.join(root, '.fsbrain', 'auth.json'), '{corrupt', 'utf8');
    const settings = await store.getAuth();
    expect(settings.enabled).toBe(false);
  });

  it('sanitizes an on-disk enabled flag that lacks a trust domain to disabled', async () => {
    await writeFile(path.join(root, 'auth-seed.json'), JSON.stringify({ enabled: true }), 'utf8');
    const store = createAuthStore(root);
    // Simulate a hand-edited file: enabled but no trust domain.
    const { mkdir, rename } = await import('node:fs/promises');
    await mkdir(path.join(root, '.fsbrain'), { recursive: true });
    await rename(path.join(root, 'auth-seed.json'), path.join(root, '.fsbrain', 'auth.json'));
    const settings = await store.getAuth();
    expect(settings.enabled).toBe(false);
  });

  it('serializes concurrent updates so neither clobbers the other', async () => {
    const store = createAuthStore(root);
    await store.setAuth({ trustDomain: 'example.org' });
    await Promise.all([
      store.setAuth({ enabled: true }),
      store.setAuth({
        agents: [{ id: 'spiffe://example.org/agent/a', match: 'exact', access: 'read' }],
      }),
    ]);
    const settings = await store.getAuth();
    expect(settings.enabled).toBe(true);
    expect(settings.agents).toHaveLength(1);
  });
});
