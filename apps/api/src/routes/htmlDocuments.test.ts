import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface FileData {
  path: string;
  content: string;
  encoding: string;
  lastModified: string;
  etag: string;
  format: string;
  mimeType: string;
  id?: string;
}

// A self-contained report whose text *looks* like markdown metadata — a
// frontmatter block, `[[wikilinks]]`, `#tags`, a skill `type:` — and shares
// words with the markdown notes, so any leak into a markdown-only pipeline
// (search, backlinks, graph, maintenance, skills, `?id=`) would surface it.
// BOM, CRLF line endings, and non-ASCII text prove the read is verbatim.
const REPORT_HTML =
  '﻿---\r\nid: html-note-id\r\ntype: skill\r\nname: Zebrafish skill\r\n---\r\n' +
  '<!DOCTYPE html>\r\n<html><head><meta charset="utf-8"><title>Zebrafish report</title>' +
  '<style>body { background: #102030; color: #f0e0d0; }</style></head>\r\n' +
  '<body><h1>Zebrafish quarterly — résumé 🐟</h1>\r\n' +
  '<p>See [[Target]] and [[missing-from-html]] #htmltag #shared</p>\r\n' +
  '<p>zebrafish zebrafish zebrafish aquaculture metrics</p>\r\n' +
  '<script>alert("never executed by the API")</script>\r\n</body></html>\r\n';

describe('HTML documents (read-only presentation format)', () => {
  let contentRoot = '';
  let outsideRoot = '';
  let baseUrl = '';
  let server: http.Server | undefined;

  async function api<T>(
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<{ status: number; body: ApiResponse<T> }> {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as ApiResponse<T> };
  }

  async function seed(relativePath: string, content: string): Promise<void> {
    const absolutePath = path.join(contentRoot, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  }

  /** Snapshot a file's bytes + mtime so a test can prove it was left untouched. */
  async function fingerprint(relativePath: string): Promise<{ bytes: string; mtimeMs: number }> {
    const absolutePath = path.join(contentRoot, relativePath);
    const [bytes, info] = await Promise.all([readFile(absolutePath, 'utf8'), stat(absolutePath)]);
    return { bytes, mtimeMs: info.mtimeMs };
  }

  beforeEach(async () => {
    contentRoot = await mkdtemp(path.join(os.tmpdir(), 'html-docs-root-'));
    outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'html-docs-outside-'));
    process.env.CONTENT_ROOT = contentRoot;
    vi.resetModules();

    await seed('report.html', REPORT_HTML);
    await seed('target.md', '---\nid: target-id\n---\n# Target\n\nZebrafish basics.\n');
    await seed('linker.md', '# Linker\n\nLinks to [[Target]] #shared about zebrafish.\n');

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
    await rm(outsideRoot, { recursive: true, force: true });
  });

  it('lists html documents in the tree with format "html"', async () => {
    await seed('reports/legacy.htm', '<p>legacy</p>');

    const { status, body } = await api<Array<Record<string, unknown>>>('GET', '/api/tree');

    expect(status).toBe(200);
    expect(body.data).toContainEqual({
      name: 'report.html',
      path: 'report.html',
      isDirectory: false,
      format: 'html',
    });
    expect(body.data).toContainEqual({
      name: 'target.md',
      path: 'target.md',
      isDirectory: false,
      format: 'markdown',
    });
    const reports = body.data?.find((node) => node.path === 'reports') as
      { format?: string; children: Array<{ path: string; format: string }> } | undefined;
    expect(reports?.format).toBeUndefined();
    expect(reports?.children).toEqual([
      expect.objectContaining({ path: 'reports/legacy.htm', format: 'html' }),
    ]);
  });

  it('reads html source verbatim with an explicit format and mime type, and no id', async () => {
    const { status, body } = await api<FileData>('GET', '/api/file?path=report.html');

    expect(status).toBe(200);
    const data = body.data!;
    expect(data.content).toBe(REPORT_HTML);
    expect(Buffer.from(data.content, 'utf8').equals(Buffer.from(REPORT_HTML, 'utf8'))).toBe(true);
    expect(data).toMatchObject({
      path: 'report.html',
      encoding: 'utf-8',
      format: 'html',
      mimeType: 'text/html',
    });
    expect(data.etag).toMatch(/^[0-9a-f]{40}$/);
    const { mtime } = await stat(path.join(contentRoot, 'report.html'));
    expect(data.lastModified).toBe(mtime.toISOString());
    // The frontmatter-looking `id:` inside HTML is never treated as a note id.
    expect(data).not.toHaveProperty('id');
  });

  it('reads .htm and upper-case extensions as html too', async () => {
    await seed('Legacy.HTM', '<p>legacy</p>');

    const { status, body } = await api<FileData>('GET', '/api/file?path=Legacy.HTM');

    expect(status).toBe(200);
    expect(body.data).toMatchObject({ content: '<p>legacy</p>', format: 'html' });
  });

  it('keeps the markdown read shape, adding only format + mimeType', async () => {
    const { status, body } = await api<FileData>('GET', '/api/file?path=target.md');

    expect(status).toBe(200);
    expect(body.data).toEqual({
      path: 'target.md',
      content: '---\nid: target-id\n---\n# Target\n\nZebrafish basics.\n',
      encoding: 'utf-8',
      lastModified: expect.any(String),
      etag: expect.stringMatching(/^[0-9a-f]{40}$/),
      format: 'markdown',
      mimeType: 'text/markdown',
      id: 'target-id',
    });
  });

  it('rejects traversal, absolute, hidden, outside-root, and non-document reads with 400', async () => {
    await seed('.fsbrain/internal.html', '<p>internal</p>');
    await seed('docs/.hidden/x.html', '<p>hidden dir</p>');
    await seed('.x.html', '<p>dotfile</p>');
    await seed('notes.txt', 'plain text');
    await writeFile(path.join(outsideRoot, 'secret.html'), '<p>outside</p>', 'utf8');
    const outsideRelative = path.relative(contentRoot, path.join(outsideRoot, 'secret.html'));

    for (const requested of [
      '../x.html',
      'a/../../x.html',
      '..\\x.html',
      '/etc/x.html',
      path.join(outsideRoot, 'secret.html'),
      outsideRelative,
      '.fsbrain/internal.html',
      'docs/.hidden/x.html',
      '.x.html',
      'a\u0000.html',
      'notes.txt',
    ]) {
      const { status, body } = await api<FileData>(
        'GET',
        `/api/file?path=${encodeURIComponent(requested)}`,
      );
      expect({ requested, status }).toEqual({ requested, status: 400 });
      expect(body.error?.code).toBe('invalid_path');
    }
  });

  it('returns 404 for a missing html document', async () => {
    const { status, body } = await api<FileData>('GET', '/api/file?path=missing.html');

    expect(status).toBe(404);
    expect(body.error?.code).toBe('not_found');
  });

  it('keeps block reads markdown-only', async () => {
    const block = await api('GET', '/api/block?path=report.html&block=intro');
    expect(block.status).toBe(400);
    expect(block.body.error?.code).toBe('invalid_path');

    const anchors = await api('GET', '/api/block-anchors?path=report.html');
    expect(anchors.status).toBe(400);
    expect(anchors.body.error?.code).toBe('invalid_path');
  });

  it('rejects every write to an html document and leaves it untouched', async () => {
    const before = await fingerprint('report.html');

    const attempts: Array<[string, string, unknown]> = [
      ['PUT', '/api/file', { path: 'report.html', content: '<p>overwritten</p>' }],
      ['PATCH', '/api/file', { path: 'report.html', op: { type: 'append', text: 'x' } }],
      ['PATCH', '/api/file', { path: 'report.html', op: { type: 'ensure_id' } }],
      ['POST', '/api/file', { path: 'report.html', content: '<p>recreated</p>' }],
      ['POST', '/api/file', { path: 'created.html', content: '<p>new</p>' }],
      ['PATCH', '/api/path', { fromPath: 'report.html', toPath: 'moved.html' }],
      ['PATCH', '/api/path', { fromPath: 'report.html', toPath: 'report.md' }],
      ['PATCH', '/api/path', { fromPath: 'linker.md', toPath: 'linker.html' }],
      ['DELETE', '/api/path?path=report.html', undefined],
    ];
    for (const [method, pathname, body] of attempts) {
      const result = await api(method, pathname, body);
      expect({ method, pathname, status: result.status }).toEqual({
        method,
        pathname,
        status: 400,
      });
      expect(result.body.error?.code).toBe('invalid_path');
    }

    expect(await fingerprint('report.html')).toEqual(before);
    for (const neverCreated of ['created.html', 'moved.html', 'report.md', 'linker.html']) {
      await expect(stat(path.join(contentRoot, neverCreated))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
    await expect(readFile(path.join(contentRoot, 'linker.md'), 'utf8')).resolves.toContain(
      'Links to [[Target]]',
    );

    // Nothing was recorded as a change.
    const audit = await api<unknown[]>('GET', '/api/audit');
    expect(audit.body.data).toEqual([]);
  });

  it('never applies an approved proposal against an html document', async () => {
    const before = await fingerprint('report.html');

    for (const proposal of [
      { action: 'update', path: 'report.html', content: '<p>agent rewrite</p>' },
      { action: 'delete', path: 'report.html' },
      { action: 'create', path: 'agent.html', content: '<p>agent page</p>' },
    ]) {
      const created = await api<{ id: string }>('POST', '/api/proposals', proposal);
      expect(created.status).toBe(201);

      const resolved = await api('POST', '/api/proposals/resolve', {
        id: created.body.data!.id,
        decision: 'approve',
      });
      expect(resolved.status).toBe(400);
      expect(resolved.body.error?.code).toBe('invalid_path');
    }

    expect(await fingerprint('report.html')).toEqual(before);
    await expect(stat(path.join(contentRoot, 'agent.html'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps folder operations format-agnostic for folders that contain html', async () => {
    await seed('site/index.html', '<h1>site</h1>');
    await seed('site/notes.md', '# notes');

    const moved = await api('PATCH', '/api/path', { fromPath: 'site', toPath: 'archive/site' });
    expect(moved.status).toBe(200);
    await expect(readFile(path.join(contentRoot, 'archive/site/index.html'), 'utf8')).resolves.toBe(
      '<h1>site</h1>',
    );

    const deleted = await api('DELETE', '/api/path?path=archive&recursive=true');
    expect(deleted.status).toBe(200);
    await expect(stat(path.join(contentRoot, 'archive'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('never feeds html into markdown-only pipelines', async () => {
    // Backlinks and `?id=` lookups read every listed path as markdown; an HTML
    // document in the tree must not break them (or appear in them).
    const backlinks = await api<Array<{ path: string }>>('GET', '/api/backlinks?path=target.md');
    expect(backlinks.status).toBe(200);
    expect(backlinks.body.data?.map((link) => link.path)).toEqual(['linker.md']);

    const byId = await api<FileData>('GET', '/api/file?id=target-id');
    expect(byId.status).toBe(200);
    expect(byId.body.data).toMatchObject({ path: 'target.md', format: 'markdown' });

    const htmlId = await api('GET', '/api/file?id=html-note-id');
    expect(htmlId.status).toBe(400);

    const reads: Array<[string, (data: unknown) => void]> = [
      [
        '/api/search?q=zebrafish',
        (data) => expect((data as Array<{ path: string }>).length).toBeGreaterThan(0),
      ],
      ['/api/search?tag=htmltag', (data) => expect(data).toEqual([])],
      [
        '/api/search?tag=shared',
        (data) =>
          expect((data as Array<{ path: string }>).map((m) => m.path)).toEqual(['linker.md']),
      ],
      [
        '/api/semantic-search?q=zebrafish%20aquaculture%20metrics',
        (data) => expect((data as unknown[]).length).toBeGreaterThan(0),
      ],
      [
        '/api/hybrid-search?q=zebrafish',
        (data) => expect((data as unknown[]).length).toBeGreaterThan(0),
      ],
      [
        '/api/context?q=zebrafish',
        (data) => expect((data as { items: unknown[] }).items.length).toBeGreaterThan(0),
      ],
      ['/api/think?q=zebrafish%20quarterly%20report', () => undefined],
      [
        '/api/graph',
        (data) =>
          expect((data as { nodes: Array<{ id: string }> }).nodes.map((n) => n.id).sort()).toEqual([
            'linker.md',
            'target.md',
          ]),
      ],
      ['/api/maintenance', () => undefined],
      ['/api/skills', (data) => expect(data).toEqual([])],
      ['/api/skills/curator', () => undefined],
      ['/api/feedback', () => undefined],
    ];
    for (const [pathname, check] of reads) {
      const { status, body } = await api('GET', pathname);
      expect({ pathname, status }).toEqual({ pathname, status: 200 });
      const serialized = JSON.stringify(body.data);
      expect(serialized, pathname).not.toContain('report.html');
      expect(serialized, pathname).not.toContain('missing-from-html');
      expect(serialized, pathname).not.toContain('htmltag');
      check(body.data);
    }
  });
});
