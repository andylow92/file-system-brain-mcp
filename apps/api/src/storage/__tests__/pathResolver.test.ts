import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPathResolver, StoragePathError } from '../pathResolver.js';

describe('createPathResolver', () => {
  it('rejects traversal and absolute paths', () => {
    const resolver = createPathResolver('/tmp/content-root');

    expect(() => resolver.resolvePath('../secrets.md')).toThrow(StoragePathError);
    expect(() => resolver.resolvePath('/etc/passwd')).toThrow(StoragePathError);
    expect(() => resolver.resolvePath('nested/../../oops.md')).toThrow(StoragePathError);
    expect(() => resolver.resolvePath('safe/path.md')).not.toThrow();
  });

  it('normalizes windows separators and keeps paths in root', () => {
    const contentRoot = path.join(os.tmpdir(), 'repo-content');
    const resolver = createPathResolver(contentRoot);

    const resolved = resolver.resolvePath('docs\\guide.md');

    expect(resolved).toBe(path.join(contentRoot, 'docs', 'guide.md'));
  });

  it('allows only markdown paths for markdown operations', () => {
    const resolver = createPathResolver('/tmp/content-root');

    expect(() => resolver.resolveMarkdownPath('docs/page.txt')).toThrow(StoragePathError);
    expect(() => resolver.resolveMarkdownPath('docs/page.md')).not.toThrow();
    // HTML is read-only: markdown (write) operations keep rejecting it.
    expect(() => resolver.resolveMarkdownPath('reports/q3.html')).toThrow(StoragePathError);
  });

  it('resolves readable documents (markdown + html) with their format', () => {
    const contentRoot = path.join(os.tmpdir(), 'repo-content');
    const resolver = createPathResolver(contentRoot);

    expect(resolver.resolveDocumentPath('a.md')).toEqual({
      absolutePath: path.join(contentRoot, 'a.md'),
      format: 'markdown',
    });
    expect(resolver.resolveDocumentPath('reports/r.html')).toEqual({
      absolutePath: path.join(contentRoot, 'reports', 'r.html'),
      format: 'html',
    });
    expect(resolver.resolveDocumentPath('r.htm').format).toBe('html');
    expect(resolver.resolveDocumentPath('R.HTML').format).toBe('html');
    expect(resolver.resolveDocumentPath('docs\\r.html').absolutePath).toBe(
      path.join(contentRoot, 'docs', 'r.html'),
    );
  });

  it('keeps traversal, absolute, hidden, and non-document paths out of document reads', () => {
    const resolver = createPathResolver('/tmp/content-root');

    for (const rejected of [
      'x.txt',
      'app.js',
      '',
      '../x.html',
      'a/../../x.html',
      '..\\x.html',
      '/etc/x.html',
      '.fsbrain/x.html',
      'a/.hidden/x.html',
      '.x.html',
      'a\u0000.html',
    ]) {
      expect(() => resolver.resolveDocumentPath(rejected), rejected).toThrow(StoragePathError);
    }
  });
});
