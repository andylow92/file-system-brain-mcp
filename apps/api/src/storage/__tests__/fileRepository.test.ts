import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileRepository } from '../fileRepository.js';
import { createPathResolver, StoragePathError } from '../pathResolver.js';

describe('fileRepository', () => {
  let contentRoot = '';

  beforeEach(async () => {
    contentRoot = await mkdtemp(path.join(os.tmpdir(), 'content-root-'));
  });

  afterEach(async () => {
    await rm(contentRoot, { recursive: true, force: true });
  });

  it('supports markdown file CRUD', async () => {
    const repository = createFileRepository(createPathResolver(contentRoot));

    await repository.createDirectory('docs');
    await repository.createMarkdownFile('docs/notes.md', '# hello');

    await expect(repository.readMarkdownFile('docs/notes.md')).resolves.toBe('# hello');

    await repository.updateMarkdownFile('docs/notes.md', '# updated');
    await expect(repository.readMarkdownFile('docs/notes.md')).resolves.toBe('# updated');

    await repository.moveMarkdownFile('docs/notes.md', 'docs/moved.md');
    await expect(repository.readMarkdownFile('docs/notes.md')).rejects.toThrow(StoragePathError);
    await expect(repository.readMarkdownFile('docs/moved.md')).resolves.toBe('# updated');

    await repository.deletePath('docs/moved.md');
    await expect(repository.readMarkdownFile('docs/moved.md')).rejects.toThrow(StoragePathError);
  });

  it('generates nested markdown-only tree output', async () => {
    const repository = createFileRepository(createPathResolver(contentRoot));

    await repository.createDirectory('docs/guides');
    await repository.createMarkdownFile('docs/guides/a.md', 'a');
    await repository.createMarkdownFile('README.md', 'root');

    const tree = await repository.listTree('');

    expect(tree.map((entry) => entry.path)).toEqual(['docs', 'README.md']);

    const docsNode = tree.find((entry) => entry.path === 'docs');
    expect(docsNode?.isDirectory).toBe(true);
    expect(docsNode?.children?.[0]?.path).toBe('docs/guides');
    expect(docsNode?.children?.[0]?.children?.[0]?.path).toBe('docs/guides/a.md');
    expect(docsNode?.children?.[0]?.children?.[0]?.isDirectory).toBe(false);
  });

  it('lists html/htm documents beside markdown, each with its format', async () => {
    const repository = createFileRepository(createPathResolver(contentRoot));

    await mkdir(path.join(contentRoot, 'reports'), { recursive: true });
    await mkdir(path.join(contentRoot, '.fsbrain'), { recursive: true });
    await writeFile(path.join(contentRoot, 'note.md'), '# note', 'utf8');
    await writeFile(path.join(contentRoot, 'reports', 'q3.html'), '<h1>Q3</h1>', 'utf8');
    await writeFile(path.join(contentRoot, 'reports', 'LEGACY.HTM'), '<h1>old</h1>', 'utf8');
    // Still excluded: hidden files/dirs and every other extension.
    await writeFile(path.join(contentRoot, '.x.html'), '<p>hidden</p>', 'utf8');
    await writeFile(path.join(contentRoot, '.fsbrain', 'internal.html'), '<p>internal</p>', 'utf8');
    await writeFile(path.join(contentRoot, 'notes.txt'), 'plain', 'utf8');
    await writeFile(path.join(contentRoot, 'app.js'), 'alert(1)', 'utf8');

    const tree = await repository.listTree('');

    expect(tree.map((entry) => entry.path)).toEqual(['note.md', 'reports']);
    expect(tree.find((entry) => entry.path === 'note.md')?.format).toBe('markdown');
    const reports = tree.find((entry) => entry.path === 'reports');
    expect(reports?.format).toBeUndefined();
    expect(reports?.children?.map((entry) => [entry.path, entry.format])).toEqual([
      ['reports/LEGACY.HTM', 'html'],
      ['reports/q3.html', 'html'],
    ]);
  });
});
