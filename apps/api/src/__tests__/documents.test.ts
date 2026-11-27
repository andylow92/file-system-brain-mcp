import { describe, expect, it } from 'vitest';

import { documentFormatForPath, mimeTypeForFormat } from '@repo/shared';

describe('documentFormatForPath', () => {
  it('maps .md to markdown, case-insensitively', () => {
    expect(documentFormatForPath('note.md')).toBe('markdown');
    expect(documentFormatForPath('docs/Guide.MD')).toBe('markdown');
  });

  it('maps .html and .htm to html, case-insensitively', () => {
    expect(documentFormatForPath('report.html')).toBe('html');
    expect(documentFormatForPath('reports/Q3.htm')).toBe('html');
    expect(documentFormatForPath('R.HTML')).toBe('html');
    expect(documentFormatForPath('legacy.HtM')).toBe('html');
  });

  it('returns null for anything else', () => {
    for (const path of [
      'notes.txt',
      'app.js',
      'image.png',
      'README',
      '',
      'report.html.txt',
      'notes.md.bak',
      'report.xhtml',
      'note.markdown',
    ]) {
      expect(documentFormatForPath(path)).toBeNull();
    }
  });

  it('judges only the final path segment', () => {
    expect(documentFormatForPath('site.html/readme')).toBeNull();
    expect(documentFormatForPath('notes.md/index.html')).toBe('html');
    expect(documentFormatForPath('docs\\page.htm')).toBe('html');
  });
});

describe('mimeTypeForFormat', () => {
  it('returns the MIME type for each format', () => {
    expect(mimeTypeForFormat('markdown')).toBe('text/markdown');
    expect(mimeTypeForFormat('html')).toBe('text/html');
  });
});
