import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, stat } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileNode } from '@repo/shared';

import { defaultContentRoot, loadConfig } from '../config.js';
import { createServer } from '../server.js';

interface HttpResponse<T = unknown> {
  statusCode: number;
  body: T;
}

function requestJson<T>(
  port: number,
  method: string,
  pathname: string,
  payload?: Record<string, unknown>,
): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path: pathname,
        headers: body
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: res.statusCode ?? 0,
            body: JSON.parse(raw) as T,
          });
        });
      },
    );

    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

describe('server bootstrap', () => {
  let workspaceRoot = '';
  let originalContentRoot: string | undefined;
  let originalCwd = '';

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'api-server-root-'));
    originalContentRoot = process.env.CONTENT_ROOT;
    originalCwd = process.cwd();
    process.env.CONTENT_ROOT = workspaceRoot;
    process.chdir(workspaceRoot);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalContentRoot === undefined) {
      delete process.env.CONTENT_ROOT;
    } else {
      process.env.CONTENT_ROOT = originalContentRoot;
    }
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('defaults CONTENT_ROOT to ~/.fsbrain/vault when unset', () => {
    delete process.env.CONTENT_ROOT;
    expect(loadConfig().contentRoot).toBe(defaultContentRoot());
  });

  it('creates CONTENT_ROOT on startup if it does not exist', () => {
    const target = path.join(workspaceRoot, 'auto', 'nested', 'vault');
    process.env.CONTENT_ROOT = target;
    createServer(loadConfig());
    return expect(stat(target).then((s) => s.isDirectory())).resolves.toBe(true);
  });

  it('starts and serves file routes against the configured CONTENT_ROOT', async () => {
    const config = loadConfig();
    const server = createServer(config);

    await new Promise<void>((resolve) => server.listen(0, resolve));

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server failed to bind a TCP port');
    }

    const port = address.port;

    const health = await requestJson<{ success: boolean; data: { contentRoot: string } }>(
      port,
      'GET',
      '/health',
    );
    expect(health.statusCode).toBe(200);
    expect(health.body.success).toBe(true);
    expect(health.body.data.contentRoot).toBe(workspaceRoot);

    const createDir = await requestJson<{ success: boolean }>(port, 'POST', '/api/dir', {
      path: 'docs',
    });
    expect(createDir.statusCode).toBe(201);
    expect(createDir.body.success).toBe(true);

    const createFile = await requestJson<{ success: boolean }>(port, 'POST', '/api/file', {
      path: 'docs/guide.md',
      content: '# guide',
    });
    expect(createFile.statusCode).toBe(201);
    expect(createFile.body.success).toBe(true);

    const readFile = await requestJson<{ success: boolean; data: { content: string } }>(
      port,
      'GET',
      '/api/file?path=docs/guide.md',
    );
    expect(readFile.statusCode).toBe(200);
    expect(readFile.body.success).toBe(true);
    expect(readFile.body.data.content).toBe('# guide');

    const tree = await requestJson<{ success: boolean; data: FileNode[] }>(
      port,
      'GET',
      '/api/tree',
    );
    expect(tree.statusCode).toBe(200);
    expect(tree.body.success).toBe(true);
    expect(tree.body.data).toEqual([
      {
        name: 'docs',
        path: 'docs',
        isDirectory: true,
        children: [
          {
            name: 'guide.md',
            path: 'docs/guide.md',
            isDirectory: false,
            format: 'markdown',
          },
        ],
      },
    ]);

    await new Promise<void>((resolve, reject) =>
      server.close((error?: Error) => (error ? reject(error) : resolve())),
    );
  });
});
