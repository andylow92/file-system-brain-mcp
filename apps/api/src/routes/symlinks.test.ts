import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canCreateSymlinks, snapshotTree } from '../__tests__/fixtures/symlinks.js';
import { createServer } from '../server.js';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface FileData {
  path: string;
  content: string;
  etag: string;
  format: string;
  mimeType: string;
}

const OUTSIDE_MD = '# Outside secret\n\nnever served by the vault\n';
const OUTSIDE_HTML = '<p>outside secret html</p>';
const REAL_MD = '# Real\n\nIntro paragraph ^intro\n';
const REPORT_HTML = '<h1>Report</h1>';

describe.skipIf(!canCreateSymlinks())('symlink confinement (routes)', () => {
  let contentRoot = '';
  let outsideRoot = '';
  let baseUrl = '';
  let server: http.Server | undefined;

  async function startServer(root: string): Promise<void> {
    server = createServer({ port: 0, contentRoot: root });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to determine server address');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async function stopServer(): Promise<void> {
    const running = server;
    server = undefined;
    if (running) {
      await new Promise<void>((resolve, reject) =>
        running.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }

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

  async function seed(base: string, relativePath: string, content: string): Promise<void> {
    const absolutePath = path.join(base, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  }

  /** Create a symlink at `relativeLinkPath` inside the vault. */
  async function link(target: string, relativeLinkPath: string, type?: 'dir'): Promise<void> {
    await symlink(target, path.join(contentRoot, relativeLinkPath), type);
  }

  beforeEach(async () => {
    contentRoot = await mkdtemp(path.join(os.tmpdir(), 'symlink-routes-root-'));
    outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'symlink-routes-outside-'));

    await seed(outsideRoot, 'secret.md', OUTSIDE_MD);
    await seed(outsideRoot, 'secret.html', OUTSIDE_HTML);
    await seed(outsideRoot, 'dir/inner.md', OUTSIDE_MD);
    await seed(contentRoot, 'notes/real.md', REAL_MD);
    await seed(contentRoot, 'report.html', REPORT_HTML);
    await seed(contentRoot, '.fsbrain/private.md', '# internal');

    // Links out of the vault: an absolute and a relative file link, an HTML link, a folder link.
    await link(path.join(outsideRoot, 'secret.md'), 'notes/escape.md');
    await link(
      path.relative(path.join(contentRoot, 'notes'), path.join(outsideRoot, 'secret.md')),
      'notes/escape-relative.md',
    );
    await link(path.join(outsideRoot, 'secret.html'), 'escape.html');
    await link(path.join(outsideRoot, 'dir'), 'linkdir', 'dir');
    // Links that stay inside the vault.
    await link('real.md', 'notes/alias.md');
    await link('report.html', 'report-alias.html');
    // Inside the vault, but onto a hidden file or onto read-only HTML under a `.md` name.
    await link('../.fsbrain/private.md', 'notes/peek.md');
    await link('../report.html', 'notes/page.md');

    await startServer(contentRoot);
  });

  afterEach(async () => {
    await stopServer();
    await rm(contentRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  it('rejects reads through a symlink that leaves the vault, for markdown and html', async () => {
    for (const pathname of [
      '/api/file?path=notes/escape.md',
      '/api/file?path=notes/escape-relative.md',
      '/api/file?path=linkdir/inner.md',
      '/api/file?path=escape.html',
      '/api/block?path=notes/escape.md&block=intro',
      '/api/block-anchors?path=notes/escape.md',
      '/api/tree?path=linkdir',
    ]) {
      const { status, body } = await api('GET', pathname);
      expect({ pathname, status, code: body.error?.code }).toEqual({
        pathname,
        status: 400,
        code: 'invalid_path',
      });
      expect(JSON.stringify(body), pathname).not.toMatch(/outside secret/i);
    }
  });

  it('rejects writes through it and leaves everything outside the vault untouched', async () => {
    const outsideBefore = await snapshotTree(outsideRoot);

    const attempts: Array<[string, string, unknown?]> = [
      ['PUT', '/api/file', { path: 'notes/escape.md', content: 'clobbered' }],
      ['PUT', '/api/file', { path: 'notes/escape-relative.md', content: 'clobbered' }],
      ['PUT', '/api/file', { path: 'linkdir/inner.md', content: 'clobbered' }],
      ['PATCH', '/api/file', { path: 'notes/escape.md', op: { type: 'append', text: 'x' } }],
      ['PATCH', '/api/file', { path: 'notes/escape.md', op: { type: 'ensure_id' } }],
      [
        'PATCH',
        '/api/file',
        { path: 'notes/escape.md', op: { type: 'append', text: 'x' }, dryRun: true },
      ],
      ['POST', '/api/file', { path: 'notes/escape.md', content: 'planted' }],
      ['POST', '/api/file', { path: 'linkdir/planted.md', content: 'planted' }],
      ['POST', '/api/dir', { path: 'linkdir/planted' }],
      ['PATCH', '/api/path', { fromPath: 'notes/escape.md', toPath: 'notes/moved.md' }],
      ['PATCH', '/api/path', { fromPath: 'linkdir/inner.md', toPath: 'notes/stolen.md' }],
      ['PATCH', '/api/path', { fromPath: 'linkdir', toPath: 'stolen-dir' }],
      ['PATCH', '/api/path', { fromPath: 'notes/real.md', toPath: 'linkdir/real.md' }],
      ['DELETE', '/api/path?path=notes/escape.md'],
      ['DELETE', '/api/path?path=linkdir/inner.md'],
      ['DELETE', '/api/path?path=linkdir&recursive=true'],
    ];
    for (const [method, pathname, body] of attempts) {
      const result = await api(method, pathname, body);
      expect({
        method,
        pathname,
        body,
        status: result.status,
        code: result.body.error?.code,
      }).toEqual({ method, pathname, body, status: 400, code: 'invalid_path' });
    }

    expect(await snapshotTree(outsideRoot)).toEqual(outsideBefore);
    // The links and the vault's own note are exactly where they were.
    await expect(readlink(path.join(contentRoot, 'notes/escape.md'))).resolves.toBe(
      path.join(outsideRoot, 'secret.md'),
    );
    await expect(readlink(path.join(contentRoot, 'linkdir'))).resolves.toBe(
      path.join(outsideRoot, 'dir'),
    );
    await expect(readFile(path.join(contentRoot, 'notes/real.md'), 'utf8')).resolves.toBe(REAL_MD);
    for (const neverCreated of ['notes/moved.md', 'notes/stolen.md', 'stolen-dir']) {
      await expect(lstat(path.join(contentRoot, neverCreated))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
    // Nothing was recorded as a change.
    const audit = await api<unknown[]>('GET', '/api/audit');
    expect(audit.body.data).toEqual([]);
  });

  it('never applies an approved proposal through it', async () => {
    const outsideBefore = await snapshotTree(outsideRoot);

    for (const proposal of [
      { action: 'update', path: 'notes/escape.md', content: 'agent rewrite' },
      { action: 'delete', path: 'notes/escape.md' },
      { action: 'create', path: 'linkdir/agent.md', content: 'agent page' },
    ]) {
      const created = await api<{ id: string }>('POST', '/api/proposals', proposal);
      expect(created.status).toBe(201);

      const resolved = await api('POST', '/api/proposals/resolve', {
        id: created.body.data!.id,
        decision: 'approve',
      });
      expect({ proposal, status: resolved.status, code: resolved.body.error?.code }).toEqual({
        proposal,
        status: 400,
        code: 'invalid_path',
      });
    }

    expect(await snapshotTree(outsideRoot)).toEqual(outsideBefore);
    const pending = await api<unknown[]>('GET', '/api/proposals?status=pending');
    expect(pending.body.data).toHaveLength(3);
  });

  it('keeps symlinks that stay inside the vault working, writing through to the target', async () => {
    const read = await api<FileData>('GET', '/api/file?path=notes/alias.md');
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({
      path: 'notes/alias.md',
      content: REAL_MD,
      format: 'markdown',
    });

    const html = await api<FileData>('GET', '/api/file?path=report-alias.html');
    expect(html.status).toBe(200);
    expect(html.body.data).toMatchObject({
      content: REPORT_HTML,
      format: 'html',
      mimeType: 'text/html',
    });

    const block = await api<{ text: string }>('GET', '/api/block?path=notes/alias.md&block=intro');
    expect(block.status).toBe(200);
    expect(block.body.data?.text).toContain('Intro paragraph');

    const put = await api<FileData>('PUT', '/api/file', {
      path: 'notes/alias.md',
      content: '# Updated via alias\n',
      etag: read.body.data!.etag,
    });
    expect(put.status).toBe(200);
    const patched = await api<FileData>('PATCH', '/api/file', {
      path: 'notes/alias.md',
      op: { type: 'append', text: 'Appended via alias.' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data?.content).toContain('# Updated via alias');
    expect(patched.body.data?.content).toContain('Appended via alias.');
    await expect(readFile(path.join(contentRoot, 'notes/real.md'), 'utf8')).resolves.toBe(
      patched.body.data!.content,
    );
    expect((await lstat(path.join(contentRoot, 'notes/alias.md'))).isSymbolicLink()).toBe(true);

    // Symlinks themselves are still never listed in the tree.
    const tree = await api<Array<{ path: string; children?: Array<{ path: string }> }>>(
      'GET',
      '/api/tree',
    );
    expect(tree.body.data?.map((node) => node.path)).toEqual(['notes', 'report.html']);
    expect(tree.body.data?.[0]?.children?.map((node) => node.path)).toEqual(['notes/real.md']);
  });

  it('rejects in-vault symlinks onto a hidden file or onto read-only html', async () => {
    const vaultBefore = await snapshotTree(contentRoot);

    const attempts: Array<[string, string, unknown?]> = [
      ['GET', '/api/file?path=notes/peek.md'],
      ['PUT', '/api/file', { path: 'notes/peek.md', content: 'x' }],
      ['GET', '/api/file?path=notes/page.md'],
      ['PUT', '/api/file', { path: 'notes/page.md', content: '<script>x</script>' }],
      ['PATCH', '/api/file', { path: 'notes/page.md', op: { type: 'append', text: 'x' } }],
      ['DELETE', '/api/path?path=notes/page.md'],
    ];
    for (const [method, pathname, body] of attempts) {
      const result = await api(method, pathname, body);
      expect({ method, pathname, status: result.status, code: result.body.error?.code }).toEqual({
        method,
        pathname,
        status: 400,
        code: 'invalid_path',
      });
    }

    expect(await snapshotTree(contentRoot)).toEqual(vaultBefore);
  });

  it('lists and searches past broken or looping symlinks, and never creates through one', async () => {
    await link(path.join(outsideRoot, 'missing.md'), 'notes/dangling.md');
    await link(path.join(outsideRoot, 'missing-dir'), 'ghostdir', 'dir');
    await link('loop.md', 'loop.md');

    const tree = await api<Array<{ path: string }>>('GET', '/api/tree');
    expect(tree.status).toBe(200);
    expect(tree.body.data?.map((node) => node.path)).toEqual(['notes', 'report.html']);

    const search = await api<Array<{ path: string }>>('GET', '/api/search?q=Intro');
    expect(search.status).toBe(200);
    expect(search.body.data?.map((match) => match.path)).toEqual(['notes/real.md']);

    for (const [pathname, body] of [
      ['/api/file', { path: 'notes/dangling.md', content: 'planted' }],
      ['/api/file', { path: 'ghostdir/planted.md', content: 'planted' }],
      ['/api/dir', { path: 'ghostdir/planted' }],
    ] as const) {
      const result = await api('POST', pathname, body);
      expect({ body, status: result.status, code: result.body.error?.code }).toEqual({
        body,
        status: 400,
        code: 'invalid_path',
      });
    }
    for (const neverCreated of ['missing.md', 'missing-dir']) {
      await expect(lstat(path.join(outsideRoot, neverCreated))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  });

  it('deletes a folder holding symlinks by unlinking them, never following them out', async () => {
    await seed(contentRoot, 'trash/old.md', '# old');
    await link(path.join(outsideRoot, 'secret.md'), 'trash/link.md');
    await link(path.join(outsideRoot, 'dir'), 'trash/linkdir', 'dir');
    const outsideBefore = await snapshotTree(outsideRoot);

    const deleted = await api('DELETE', '/api/path?path=trash&recursive=true');

    expect(deleted.status).toBe(200);
    await expect(lstat(path.join(contentRoot, 'trash'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await snapshotTree(outsideRoot)).toEqual(outsideBefore);
  });

  it('works when CONTENT_ROOT itself is reached through a symlink (macOS /tmp)', async () => {
    await stopServer();
    const linkedRoot = path.join(outsideRoot, 'vault-link');
    await symlink(contentRoot, linkedRoot, 'dir');
    await startServer(linkedRoot);

    const steps: Array<[string, string, unknown, number]> = [
      ['POST', '/api/file', { path: 'notes/new.md', content: '# New\n' }, 201],
      ['PUT', '/api/file', { path: 'notes/new.md', content: '# Newer\n' }, 200],
      ['PATCH', '/api/file', { path: 'notes/new.md', op: { type: 'append', text: 'More.' } }, 200],
      ['POST', '/api/dir', { path: 'archive' }, 201],
      ['PATCH', '/api/path', { fromPath: 'notes/new.md', toPath: 'archive/new.md' }, 200],
    ];
    for (const [method, pathname, body, expected] of steps) {
      const result = await api(method, pathname, body);
      expect({ method, pathname, status: result.status }).toEqual({
        method,
        pathname,
        status: expected,
      });
    }

    const moved = await api<FileData>('GET', '/api/file?path=archive/new.md');
    expect(moved.status).toBe(200);
    expect(moved.body.data?.content).toBe('# Newer\nMore.');
    expect((await api('GET', '/api/file?path=notes/alias.md')).status).toBe(200);
    expect((await api('DELETE', '/api/path?path=archive&recursive=true')).status).toBe(200);

    // ...and a link out of the vault is still refused.
    const escaped = await api('GET', '/api/file?path=notes/escape.md');
    expect(escaped.status).toBe(400);
    expect(escaped.body.error?.code).toBe('invalid_path');
  });
});
