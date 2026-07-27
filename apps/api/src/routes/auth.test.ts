import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry, AuthStatusResponse, AuthTestResponse } from '@repo/shared';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

const TRUST_DOMAIN = 'example.org';

describe('optional SPIFFE auth', () => {
  let contentRoot = '';
  let baseUrl = '';
  let server: http.Server | undefined;
  /** Flipped per test to simulate remote callers without real networking. */
  let simulateLoopback = true;

  let privateKey: CryptoKey;
  let jwksInline = '';

  async function mint(
    sub: string,
    options: { aud?: string; lifetimeSeconds?: number; key?: CryptoKey } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const lifetime = options.lifetimeSeconds ?? 300;
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject(sub)
      .setAudience(options.aud ?? 'fsbrain')
      .setIssuedAt(now + Math.min(0, lifetime))
      .setExpirationTime(now + lifetime)
      .sign(options.key ?? privateKey);
  }

  async function api<T>(
    method: string,
    pathname: string,
    options: { body?: unknown; token?: string; actor?: string } = {},
  ): Promise<{ status: number; headers: Headers; body: ApiResponse<T> }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
    if (options.actor) headers['X-Actor'] = options.actor;
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return {
      status: response.status,
      headers: response.headers,
      body: (await response.json()) as ApiResponse<T>,
    };
  }

  /** Configure + enable auth from the loopback owner surface. */
  async function enableAuth(extra: Record<string, unknown> = {}): Promise<void> {
    const wasLoopback = simulateLoopback;
    simulateLoopback = true;
    const result = await api('PUT', '/api/auth', {
      body: {
        trustDomain: TRUST_DOMAIN,
        jwks: { inline: jwksInline },
        enabled: true,
        ...extra,
      },
    });
    expect(result.status).toBe(200);
    simulateLoopback = wasLoopback;
  }

  beforeEach(async () => {
    contentRoot = await mkdtemp(path.join(os.tmpdir(), 'auth-routes-'));
    process.env.CONTENT_ROOT = contentRoot;
    simulateLoopback = true;
    vi.resetModules();

    const pair = await generateKeyPair('RS256', { extractable: true });
    privateKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    jwksInline = JSON.stringify({ keys: [{ ...jwk, alg: 'RS256', kid: 'test-key' }] });

    const { createServer } = await import('../server.js');
    const created = createServer(undefined, { authIsLoopback: () => simulateLoopback });
    server = created;
    await new Promise<void>((resolve) => created.listen(0, () => resolve()));
    const address = created.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
    await rm(contentRoot, { recursive: true, force: true });
  });

  it('is disabled by default: every route stays open, even for remote callers', async () => {
    simulateLoopback = false;
    const write = await api('POST', '/api/file', {
      body: { path: 'notes/open.md', content: '# open' },
    });
    expect(write.status).toBe(201);
    const tree = await api('GET', '/api/tree');
    expect(tree.status).toBe(200);
    const status = await api<AuthStatusResponse>('GET', '/api/auth');
    expect(status.body.data?.state).toBe('disabled');
    // Pre-auth behavior preserved: health includes the vault path.
    const health = await api<{ contentRoot?: string }>('GET', '/health');
    expect(health.body.data?.contentRoot).toBe(contentRoot);
  });

  it('only loopback can change auth settings while auth is disabled', async () => {
    simulateLoopback = false;
    const denied = await api('PUT', '/api/auth', {
      body: { trustDomain: 'attacker.example', enabled: true },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error?.code).toBe('local_only');

    simulateLoopback = true;
    const allowed = await api<AuthStatusResponse>('PUT', '/api/auth', {
      body: { trustDomain: TRUST_DOMAIN },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data?.trustDomain).toBe(TRUST_DOMAIN);
  });

  it('keeps loopback exempt by default once enabled (local UI and embedded MCP)', async () => {
    await enableAuth();
    const tree = await api('GET', '/api/tree');
    expect(tree.status).toBe(200);
  });

  it('requires a valid JWT-SVID from remote callers once enabled', async () => {
    await enableAuth();
    simulateLoopback = false;

    const anonymous = await api('GET', '/api/tree');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error?.code).toBe('unauthorized');
    expect(anonymous.headers.get('www-authenticate')).toContain('Bearer');

    const good = await api('GET', '/api/tree', {
      token: await mint(`spiffe://${TRUST_DOMAIN}/agent/reader`),
    });
    expect(good.status).toBe(200);

    const expired = await api('GET', '/api/tree', {
      token: await mint(`spiffe://${TRUST_DOMAIN}/agent/reader`, { lifetimeSeconds: -3600 }),
    });
    expect(expired.status).toBe(401);
    expect(expired.body.error?.code).toBe('invalid_token');

    const wrongAudience = await api('GET', '/api/tree', {
      token: await mint(`spiffe://${TRUST_DOMAIN}/agent/reader`, { aud: 'somewhere-else' }),
    });
    expect(wrongAudience.status).toBe(401);
    expect(wrongAudience.body.error?.code).toBe('invalid_token');

    const notSpiffe = await api('GET', '/api/tree', { token: await mint('user:alice') });
    expect(notSpiffe.status).toBe(401);
    expect(notSpiffe.body.error?.code).toBe('not_spiffe_subject');

    const wrongDomain = await api('GET', '/api/tree', {
      token: await mint('spiffe://other.org/agent/reader'),
    });
    expect(wrongDomain.status).toBe(401);
    expect(wrongDomain.body.error?.code).toBe('wrong_trust_domain');

    const forgedKey = await generateKeyPair('RS256', { extractable: true });
    const forged = await api('GET', '/api/tree', {
      token: await mint(`spiffe://${TRUST_DOMAIN}/agent/reader`, { key: forgedKey.privateKey }),
    });
    expect(forged.status).toBe(401);
  });

  it('disabling from loopback reopens the vault immediately (per-request check)', async () => {
    await enableAuth();
    simulateLoopback = false;
    expect((await api('GET', '/api/tree')).status).toBe(401);

    simulateLoopback = true;
    expect((await api('PUT', '/api/auth', { body: { enabled: false } })).status).toBe(200);
    simulateLoopback = false;
    expect((await api('GET', '/api/tree')).status).toBe(200);
  });

  it('attributes writes to the verified SPIFFE ID, ignoring a spoofed X-Actor', async () => {
    await enableAuth();
    simulateLoopback = false;
    const spiffeId = `spiffe://${TRUST_DOMAIN}/agent/writer`;
    const write = await api('POST', '/api/file', {
      token: await mint(spiffeId),
      actor: 'human',
      body: { path: 'notes/attributed.md', content: '# attributed' },
    });
    expect(write.status).toBe(201);

    simulateLoopback = true;
    const audit = await api<AuditEntry[]>('GET', '/api/audit');
    expect(audit.status).toBe(200);
    const entry = (audit.body.data ?? []).find((item) => item.path === 'notes/attributed.md');
    expect(entry?.actor).toBe(spiffeId);
  });

  it('enforces access rules: none, read-only, readwrite, admin', async () => {
    await enableAuth({
      defaultAccess: 'none',
      agents: [
        { id: `spiffe://${TRUST_DOMAIN}/readonly/`, match: 'prefix', access: 'read' },
        { id: `spiffe://${TRUST_DOMAIN}/agent/editor`, match: 'exact', access: 'readwrite' },
        { id: `spiffe://${TRUST_DOMAIN}/agent/operator`, match: 'exact', access: 'admin' },
      ],
    });
    simulateLoopback = false;

    const unknown = await api('GET', '/api/tree', {
      token: await mint(`spiffe://${TRUST_DOMAIN}/agent/stranger`),
    });
    expect(unknown.status).toBe(403);
    expect(unknown.body.error?.code).toBe('not_authorized');

    const readerToken = await mint(`spiffe://${TRUST_DOMAIN}/readonly/scout`);
    expect((await api('GET', '/api/tree', { token: readerToken })).status).toBe(200);
    const readerWrite = await api('POST', '/api/file', {
      token: readerToken,
      body: { path: 'notes/blocked.md', content: 'x' },
    });
    expect(readerWrite.status).toBe(403);
    expect(readerWrite.body.error?.code).toBe('read_only');

    const editorToken = await mint(`spiffe://${TRUST_DOMAIN}/agent/editor`);
    expect(
      (
        await api('POST', '/api/file', {
          token: editorToken,
          body: { path: 'notes/allowed.md', content: 'x' },
        })
      ).status,
    ).toBe(201);
    const editorAdmin = await api('PUT', '/api/auth', {
      token: editorToken,
      body: { allowLoopback: true },
    });
    expect(editorAdmin.status).toBe(403);
    expect(editorAdmin.body.error?.code).toBe('admin_required');

    const operatorToken = await mint(`spiffe://${TRUST_DOMAIN}/agent/operator`);
    const operatorAdmin = await api<AuthStatusResponse>('PUT', '/api/auth', {
      token: operatorToken,
      body: { defaultAccess: 'read' },
    });
    expect(operatorAdmin.status).toBe(200);
    expect(operatorAdmin.body.data?.defaultAccess).toBe('read');
  });

  it('reports status and dry-run token tests, hiding rules from non-admin callers', async () => {
    await enableAuth({
      agents: [{ id: `spiffe://${TRUST_DOMAIN}/agent/ops`, match: 'exact', access: 'admin' }],
    });

    const local = await api<AuthStatusResponse>('GET', '/api/auth');
    expect(local.body.data?.agents).toHaveLength(1);
    expect(local.body.data?.caller.kind).toBe('loopback');
    expect(local.body.data?.bearerReady).toBe(true);
    expect(local.body.data?.jwksSource).toBe('inline');

    simulateLoopback = false;
    const remote = await api<AuthStatusResponse>('GET', '/api/auth', {
      token: await mint(`spiffe://${TRUST_DOMAIN}/agent/viewer`),
    });
    expect(remote.status).toBe(200);
    expect(remote.body.data?.agents).toBeUndefined();
    expect(remote.body.data?.caller).toEqual({
      kind: 'spiffe',
      spiffeId: `spiffe://${TRUST_DOMAIN}/agent/viewer`,
      access: 'readwrite',
    });

    const testGood = await api<AuthTestResponse>('POST', '/api/auth/test', {
      token: await mint(`spiffe://${TRUST_DOMAIN}/agent/viewer`),
      body: { token: await mint(`spiffe://${TRUST_DOMAIN}/agent/probe`) },
    });
    expect(testGood.body.data).toMatchObject({
      valid: true,
      spiffeId: `spiffe://${TRUST_DOMAIN}/agent/probe`,
      access: 'readwrite',
    });

    const testBad = await api<AuthTestResponse>('POST', '/api/auth/test', {
      token: await mint(`spiffe://${TRUST_DOMAIN}/agent/viewer`),
      body: { token: 'garbage' },
    });
    expect(testBad.body.data?.valid).toBe(false);
    expect(testBad.body.data?.reason).toBeTruthy();
  });

  it('keeps /health alive without credentials but hides the vault path remotely', async () => {
    await enableAuth();
    simulateLoopback = false;
    const health = await api<{ status: string; contentRoot?: string }>('GET', '/health');
    expect(health.status).toBe(200);
    expect(health.body.data?.status).toBe('ok');
    expect(health.body.data?.contentRoot).toBeUndefined();

    simulateLoopback = true;
    const local = await api<{ contentRoot?: string }>('GET', '/health');
    expect(local.body.data?.contentRoot).toBe(contentRoot);
  });

  it('puts the live event stream behind the same guard', async () => {
    await enableAuth();
    simulateLoopback = false;

    const denied = await fetch(`${baseUrl}/api/events`);
    expect(denied.status).toBe(401);
    await denied.body?.cancel();

    const token = await mint(`spiffe://${TRUST_DOMAIN}/agent/listener`);
    const allowed = await fetch(`${baseUrl}/api/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('content-type')).toContain('text/event-stream');
    await allowed.body?.cancel();
  });

  it('supports a JWKS file source and picks up rotation without a restart', async () => {
    const jwksPath = path.join(contentRoot, 'bundle.jwks.json');
    await writeFile(jwksPath, jwksInline, 'utf8');
    await enableAuth({ jwks: { file: jwksPath } });
    simulateLoopback = false;

    const oldToken = await mint(`spiffe://${TRUST_DOMAIN}/agent/rotated`);
    expect((await api('GET', '/api/tree', { token: oldToken })).status).toBe(200);

    // Rotate: a brand-new key replaces the bundle in place.
    const nextPair = await generateKeyPair('RS256', { extractable: true });
    const nextJwk = await exportJWK(nextPair.publicKey);
    await writeFile(
      jwksPath,
      JSON.stringify({ keys: [{ ...nextJwk, alg: 'RS256', kid: 'rotated-key' }] }),
      'utf8',
    );

    const staleDenied = await api('GET', '/api/tree', { token: oldToken });
    expect(staleDenied.status).toBe(401);

    const freshToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'rotated-key' })
      .setSubject(`spiffe://${TRUST_DOMAIN}/agent/rotated`)
      .setAudience('fsbrain')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(nextPair.privateKey);
    expect((await api('GET', '/api/tree', { token: freshToken })).status).toBe(200);
  });

  it('can require auth even on loopback (reverse-proxy hardening) and recover via admin', async () => {
    await enableAuth({
      agents: [{ id: `spiffe://${TRUST_DOMAIN}/agent/operator`, match: 'exact', access: 'admin' }],
      allowLoopback: false,
    });

    // Loopback is no longer exempt…
    expect((await api('GET', '/api/tree')).status).toBe(401);

    // …but an admin SVID still manages settings, restoring the exemption.
    const restore = await api('PUT', '/api/auth', {
      token: await mint(`spiffe://${TRUST_DOMAIN}/agent/operator`),
      body: { allowLoopback: true },
    });
    expect(restore.status).toBe(200);
    expect((await api('GET', '/api/tree')).status).toBe(200);
  });
});
