import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphData } from '@repo/shared';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

describe('GET /api/graph', () => {
  let contentRoot = '';
  let baseUrl = '';
  let server: http.Server | undefined;

  async function api<T>(
    method: string,
    pathname: string,
    options: { body?: unknown } = {},
  ): Promise<{ status: number; body: ApiResponse<T> }> {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: (await response.json()) as ApiResponse<T> };
  }

  beforeEach(async () => {
    contentRoot = await mkdtemp(path.join(os.tmpdir(), 'graph-root-'));
    process.env.CONTENT_ROOT = contentRoot;
    vi.resetModules();

    const { createServer } = await import('../server.js');
    server = createServer();
    await new Promise<void>((resolve) => server!.listen(0, () => resolve()));

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to determine server address');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
    await rm(contentRoot, { recursive: true, force: true });
  });

  it('returns nodes and edges built from wikilinks, with unresolved placeholders and typed edges', async () => {
    await api('POST', '/api/file', {
      body: {
        path: 'alpha.md',
        content: '---\ntags: [topic]\n---\n# Alpha\n\nSee [[beta]] and [[ghost]].',
      },
    });
    await api('POST', '/api/file', {
      body: { path: 'beta.md', content: '# Beta\n\nBacks [[alpha|rel:supports]].' },
    });

    const result = await api<GraphData>('GET', '/api/graph');
    expect(result.status).toBe(200);
    const graph = result.body.data!;

    // Real notes are nodes; the audit store is never a node.
    const ids = graph.nodes.map((node) => node.id);
    expect(ids).toContain('alpha.md');
    expect(ids).toContain('beta.md');
    expect(ids.some((id) => id.startsWith('.fsbrain'))).toBe(false);

    // Tags ride along on the node.
    expect(graph.nodes.find((node) => node.id === 'alpha.md')?.tags).toEqual(['topic']);

    // The unresolved [[ghost]] target is a distinct placeholder node.
    const ghost = graph.nodes.find((node) => node.id === 'ghost');
    expect(ghost).toMatchObject({ id: 'ghost', unresolved: true });

    // Resolved, unresolved, and typed edges are all present.
    expect(graph.edges).toContainEqual({ source: 'alpha.md', target: 'beta.md' });
    expect(graph.edges).toContainEqual({ source: 'alpha.md', target: 'ghost' });
    expect(graph.edges).toContainEqual({
      source: 'beta.md',
      target: 'alpha.md',
      type: 'supports',
    });
  });

  it('self-wires typed edges from frontmatter relation fields', async () => {
    await api('POST', '/api/file', {
      body: {
        path: 'meeting.md',
        content: '---\ntype: meeting\nrelated: [[project]]\n---\n# Weekly sync',
      },
    });
    await api('POST', '/api/file', { body: { path: 'project.md', content: '# Project' } });

    const result = await api<GraphData>('GET', '/api/graph');
    expect(result.status).toBe(200);
    const graph = result.body.data!;

    // The `related:` frontmatter field wires a typed edge with no `rel:` alias.
    expect(graph.edges).toContainEqual({
      source: 'meeting.md',
      target: 'project.md',
      type: 'related',
    });
    // The `type: meeting` scalar is metadata, not a link — never an edge/node.
    expect(graph.nodes.some((node) => node.id === 'meeting')).toBe(false);
  });

  it('reflects a newly written link without serving a stale cached graph', async () => {
    await api('POST', '/api/file', { body: { path: 'one.md', content: '# One' } });
    await api('POST', '/api/file', { body: { path: 'two.md', content: '# Two' } });

    const before = await api<GraphData>('GET', '/api/graph');
    expect(before.body.data!.edges).toEqual([]);

    // Add a link from one -> two; the next graph read must include it.
    await api('PUT', '/api/file', {
      body: { path: 'one.md', content: '# One\n\nNow see [[two]].' },
    });

    const after = await api<GraphData>('GET', '/api/graph');
    expect(after.body.data!.edges).toContainEqual({ source: 'one.md', target: 'two.md' });
  });
});
