import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAuthHeaderCache, resolveAuthHeader, resolveClientTlsConnect } from '../clientAuth.js';

describe('resolveAuthHeader', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-auth-'));
    resetAuthHeaderCache();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns undefined with nothing configured', async () => {
    expect(await resolveAuthHeader({})).toBeUndefined();
  });

  it('prefers a static token over a token file', async () => {
    const file = path.join(dir, 'svid.jwt');
    await writeFile(file, 'from-file', 'utf8');
    expect(
      await resolveAuthHeader({ FSBRAIN_API_TOKEN: 'static', FSBRAIN_API_TOKEN_FILE: file }),
    ).toBe('Bearer static');
  });

  it('reads a token file and picks up in-place rotation via mtime', async () => {
    const file = path.join(dir, 'svid.jwt');
    await writeFile(file, 'first-token\n', 'utf8');
    const env = { FSBRAIN_API_TOKEN_FILE: file };
    expect(await resolveAuthHeader(env)).toBe('Bearer first-token');

    await writeFile(file, 'second-token\n', 'utf8');
    // Force a distinct mtime — same-millisecond writes must not read stale.
    const future = new Date(Date.now() + 5000);
    await utimes(file, future, future);
    expect(await resolveAuthHeader(env)).toBe('Bearer second-token');
  });

  it('fails loudly on a missing or empty token file', async () => {
    await expect(
      resolveAuthHeader({ FSBRAIN_API_TOKEN_FILE: path.join(dir, 'absent.jwt') }),
    ).rejects.toThrow(/unreadable/);
    const empty = path.join(dir, 'empty.jwt');
    await writeFile(empty, '  \n', 'utf8');
    await expect(resolveAuthHeader({ FSBRAIN_API_TOKEN_FILE: empty })).rejects.toThrow(/empty/);
  });
});

describe('resolveClientTlsConnect', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-tls-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns undefined with nothing configured', () => {
    expect(resolveClientTlsConnect({})).toBeUndefined();
  });

  it('reads PEM material for cert/key/ca', async () => {
    const cert = path.join(dir, 'svid.pem');
    const key = path.join(dir, 'svid.key');
    const ca = path.join(dir, 'ca.pem');
    await writeFile(cert, 'CERT', 'utf8');
    await writeFile(key, 'KEY', 'utf8');
    await writeFile(ca, 'CA', 'utf8');
    expect(
      resolveClientTlsConnect({
        FSBRAIN_CLIENT_TLS_CERT: cert,
        FSBRAIN_CLIENT_TLS_KEY: key,
        FSBRAIN_CLIENT_TLS_CA: ca,
      }),
    ).toEqual({ cert: 'CERT', key: 'KEY', ca: 'CA' });
    // CA alone is valid: it only pins trust for a private server certificate.
    expect(resolveClientTlsConnect({ FSBRAIN_CLIENT_TLS_CA: ca })).toEqual({ ca: 'CA' });
  });

  it('requires cert and key together', () => {
    expect(() => resolveClientTlsConnect({ FSBRAIN_CLIENT_TLS_CERT: '/x.pem' })).toThrow(
      /together/,
    );
  });
});

describe('proxied mode sends the bearer credential', () => {
  let vault = '';
  let capture: http.Server | undefined;
  let seenAuthorization: Array<string | undefined> = [];
  let envBackup: Record<string, string | undefined> = {};

  beforeEach(async () => {
    vault = await mkdtemp(path.join(os.tmpdir(), 'mcp-proxy-auth-'));
    seenAuthorization = [];
    envBackup = {
      API_BASE_URL: process.env.API_BASE_URL,
      FSBRAIN_API_TOKEN: process.env.FSBRAIN_API_TOKEN,
      CONTENT_ROOT: process.env.CONTENT_ROOT,
    };
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise<void>((resolve) => {
      if (!capture) return resolve();
      capture.close(() => resolve());
    });
    capture = undefined;
    await rm(vault, { recursive: true, force: true });
  });

  it('attaches Authorization from FSBRAIN_API_TOKEN on proxied API calls', async () => {
    capture = http.createServer((req, res) => {
      seenAuthorization.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: [] }));
    });
    await new Promise<void>((resolve) => capture?.listen(0, '127.0.0.1', () => resolve()));
    const address = capture.address();
    if (!address || typeof address === 'string') throw new Error('no address');

    process.env.API_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.FSBRAIN_API_TOKEN = 'proxied-svid-token';
    vi.resetModules();
    const { bootstrap } = await import('../server.js');
    const { server, context } = await bootstrap();
    expect(context.embeddedServer).toBeUndefined();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'auth-proxy-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = (await client.callTool({ name: 'list_notes', arguments: {} })) as {
        isError?: boolean;
      };
      expect(result.isError).not.toBe(true);
      expect(seenAuthorization.length).toBeGreaterThan(0);
      expect(seenAuthorization[0]).toBe('Bearer proxied-svid-token');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
