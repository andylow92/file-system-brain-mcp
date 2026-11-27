import os from 'node:os';
import path from 'node:path';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canCreateSymlinks, snapshotTree } from '../../__tests__/fixtures/symlinks.js';
import { createFileRepository } from '../fileRepository.js';
import { createPathResolver, StoragePathError } from '../pathResolver.js';

const OUTSIDE = /resolves outside of storage root/;
const DISALLOWED_TARGET = /resolves to a hidden path or a different file type/;
const BROKEN_LINK = /goes through a broken symlink/;

/** Await `promise` and assert it rejected with a `StoragePathError` whose message matches. */
async function expectPathError(promise: Promise<unknown>, message: RegExp, label?: string) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error, label).toBeInstanceOf(StoragePathError);
  expect((error as Error).message, label).toMatch(message);
}

describe.skipIf(!canCreateSymlinks())('symlink confinement (storage)', () => {
  let contentRoot = '';
  let outsideRoot = '';
  let realRoot = '';

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
    contentRoot = await mkdtemp(path.join(os.tmpdir(), 'symlink-store-root-'));
    outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'symlink-store-outside-'));
    realRoot = await realpath(contentRoot);

    await seed(outsideRoot, 'secret.md', '# outside secret');
    await seed(outsideRoot, 'secret.html', '<p>outside</p>');
    await seed(outsideRoot, 'dir/inner.md', '# outside inner');
    await seed(contentRoot, 'notes/real.md', '# real');
    await seed(contentRoot, 'report.html', '<h1>report</h1>');
    await seed(contentRoot, '.fsbrain/private.md', '# internal');

    // Links out of the vault: an absolute and a relative file link, and a folder link.
    await link(path.join(outsideRoot, 'secret.md'), 'notes/escape.md');
    await link(
      path.relative(path.join(contentRoot, 'notes'), path.join(outsideRoot, 'secret.md')),
      'notes/escape-relative.md',
    );
    await link(path.join(outsideRoot, 'secret.html'), 'escape.html');
    await link(path.join(outsideRoot, 'dir'), 'linkdir', 'dir');
    // Links that stay inside the vault.
    await link('real.md', 'notes/alias.md');
    await link('notes', 'notes-alias', 'dir');
    await link('report.html', 'report-alias.html');
    // Inside the vault, but onto a hidden file or onto a different document format.
    await link('../.fsbrain/private.md', 'notes/peek.md');
    await link('../report.html', 'notes/page.md');
  });

  afterEach(async () => {
    await rm(contentRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  describe('resolveRealPath', () => {
    it('follows symlinks that stay inside the vault to their real target', async () => {
      const resolver = createPathResolver(contentRoot);

      await expect(
        resolver.resolveRealPath(resolver.resolveMarkdownPath('notes/alias.md')),
      ).resolves.toBe(path.join(realRoot, 'notes', 'real.md'));
      await expect(
        resolver.resolveRealPath(resolver.resolveMarkdownPath('notes-alias/real.md')),
      ).resolves.toBe(path.join(realRoot, 'notes', 'real.md'));
      await expect(
        resolver.resolveRealPath(resolver.resolveDocumentPath('report-alias.html').absolutePath),
      ).resolves.toBe(path.join(realRoot, 'report.html'));
      await expect(resolver.resolveRealPath(resolver.resolvePath('notes-alias'))).resolves.toBe(
        path.join(realRoot, 'notes'),
      );
      await expect(resolver.resolveRealPath(resolver.resolvePath(''))).resolves.toBe(realRoot);
    });

    it('rejects every path whose real location is outside the vault', async () => {
      const resolver = createPathResolver(contentRoot);

      for (const requested of [
        'notes/escape.md',
        'notes/escape-relative.md',
        'escape.html',
        'linkdir',
        'linkdir/inner.md',
      ]) {
        await expectPathError(
          resolver.resolveRealPath(resolver.resolvePath(requested)),
          OUTSIDE,
          requested,
        );
      }
    });

    it('rejects in-vault symlinks onto a hidden path or another document format', async () => {
      const resolver = createPathResolver(contentRoot);

      for (const requested of ['notes/peek.md', 'notes/page.md']) {
        await expectPathError(
          resolver.resolveRealPath(resolver.resolveMarkdownPath(requested)),
          DISALLOWED_TARGET,
          requested,
        );
      }
    });

    it('rejects with ENOENT when nothing real is there, so routes still answer 404', async () => {
      const resolver = createPathResolver(contentRoot);
      await link(path.join(outsideRoot, 'missing.md'), 'notes/dangling.md');

      for (const requested of ['notes/missing.md', 'notes/dangling.md']) {
        await expect(
          resolver.resolveRealPath(resolver.resolveMarkdownPath(requested)),
          requested,
        ).rejects.toMatchObject({ code: 'ENOENT' });
      }
    });

    it('resolves the real root lazily, so a root created after the resolver works', async () => {
      const lateRoot = path.join(outsideRoot, 'late');
      const resolver = createPathResolver(lateRoot);
      const notePath = resolver.resolveMarkdownPath('a.md');

      await expect(resolver.resolveRealPath(notePath)).rejects.toMatchObject({ code: 'ENOENT' });
      await seed(lateRoot, 'a.md', '# late');
      await expect(resolver.resolveRealPath(notePath)).resolves.toBe(
        path.join(await realpath(lateRoot), 'a.md'),
      );
    });
  });

  describe('ensureCreatableInsideRoot', () => {
    it('accepts a new path whose nearest existing folder is inside the vault', async () => {
      const resolver = createPathResolver(contentRoot);

      for (const requested of ['notes/new/deeper/x.md', 'notes-alias/new.md', 'fresh.md']) {
        await expect(
          resolver.ensureCreatableInsideRoot(resolver.resolveMarkdownPath(requested)),
          requested,
        ).resolves.toBeUndefined();
      }
    });

    it('rejects a new path under a folder link that leaves the vault, or a broken link', async () => {
      const resolver = createPathResolver(contentRoot);
      await link(path.join(outsideRoot, 'missing-dir'), 'ghostdir', 'dir');
      await link(path.join(outsideRoot, 'missing.md'), 'notes/dangling.md');

      await expectPathError(
        resolver.ensureCreatableInsideRoot(resolver.resolveMarkdownPath('linkdir/new/x.md')),
        OUTSIDE,
      );
      await expectPathError(
        resolver.ensureCreatableInsideRoot(resolver.resolveMarkdownPath('ghostdir/x.md')),
        BROKEN_LINK,
      );
      await expectPathError(
        resolver.ensureCreatableInsideRoot(resolver.resolveMarkdownPath('notes/dangling.md')),
        BROKEN_LINK,
      );
    });
  });

  describe('fileRepository', () => {
    it('refuses every read, write, listing, create, move, and delete that leaves the vault', async () => {
      const repository = createFileRepository(createPathResolver(contentRoot));
      const outsideBefore = await snapshotTree(outsideRoot);

      const attempts: Array<[string, () => Promise<unknown>]> = [
        ['read a file link', () => repository.readMarkdownFile('notes/escape.md')],
        ['read a relative link', () => repository.readMarkdownFile('notes/escape-relative.md')],
        ['read via a folder link', () => repository.readMarkdownFile('linkdir/inner.md')],
        ['update a file link', () => repository.updateMarkdownFile('notes/escape.md', 'x')],
        ['update via a folder link', () => repository.updateMarkdownFile('linkdir/inner.md', 'x')],
        ['list a folder link', () => repository.listTree('linkdir')],
        ['create on a file link', () => repository.createMarkdownFile('notes/escape.md', 'x')],
        ['create via a folder link', () => repository.createMarkdownFile('linkdir/new.md', 'x')],
        ['mkdir on a folder link', () => repository.createDirectory('linkdir')],
        ['mkdir via a folder link', () => repository.createDirectory('linkdir/sub/deeper')],
        ['move a file link', () => repository.moveMarkdownFile('notes/escape.md', 'moved.md')],
        [
          'move in via a folder link',
          () => repository.moveMarkdownFile('linkdir/inner.md', 'x.md'),
        ],
        [
          'move out via a folder link',
          () => repository.moveMarkdownFile('notes/real.md', 'linkdir/r.md'),
        ],
        ['delete a file link', () => repository.deletePath('notes/escape.md')],
        ['delete via a folder link', () => repository.deletePath('linkdir/inner.md')],
        ['delete a folder link', () => repository.deletePath('linkdir', { recursive: true })],
      ];
      for (const [label, attempt] of attempts) {
        await expectPathError(attempt(), OUTSIDE, label);
      }

      expect(await snapshotTree(outsideRoot)).toEqual(outsideBefore);
      await expect(readFile(path.join(contentRoot, 'notes/real.md'), 'utf8')).resolves.toBe(
        '# real',
      );
      await expect(readlink(path.join(contentRoot, 'notes/escape.md'))).resolves.toBe(
        path.join(outsideRoot, 'secret.md'),
      );
      for (const neverCreated of ['moved.md', 'x.md']) {
        await expect(lstat(path.join(contentRoot, neverCreated))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
    });

    it('never creates or moves anything through a broken symlink', async () => {
      const repository = createFileRepository(createPathResolver(contentRoot));
      await link(path.join(outsideRoot, 'missing.md'), 'notes/dangling.md');
      await link(path.join(outsideRoot, 'missing-dir'), 'ghostdir', 'dir');
      const outsideBefore = await snapshotTree(outsideRoot);

      await expectPathError(repository.createMarkdownFile('notes/dangling.md', 'x'), BROKEN_LINK);
      await expectPathError(repository.createMarkdownFile('ghostdir/x.md', 'x'), BROKEN_LINK);
      await expectPathError(repository.createDirectory('ghostdir/sub'), BROKEN_LINK);
      await expectPathError(
        repository.moveMarkdownFile('notes/real.md', 'notes/dangling.md'),
        BROKEN_LINK,
      );

      // Neither link target was brought into existence.
      expect(await snapshotTree(outsideRoot)).toEqual(outsideBefore);
      await expect(readFile(path.join(contentRoot, 'notes/real.md'), 'utf8')).resolves.toBe(
        '# real',
      );
    });

    it('rejects in-vault symlinks onto a hidden file or another document format', async () => {
      const repository = createFileRepository(createPathResolver(contentRoot));
      const vaultBefore = await snapshotTree(contentRoot);

      for (const requested of ['notes/peek.md', 'notes/page.md']) {
        await expectPathError(repository.readMarkdownFile(requested), DISALLOWED_TARGET, requested);
        await expectPathError(
          repository.updateMarkdownFile(requested, 'x'),
          DISALLOWED_TARGET,
          requested,
        );
        await expectPathError(repository.deletePath(requested), DISALLOWED_TARGET, requested);
      }

      expect(await snapshotTree(contentRoot)).toEqual(vaultBefore);
    });

    it('keeps symlinks that stay inside the vault working', async () => {
      const repository = createFileRepository(createPathResolver(contentRoot));

      await expect(repository.readMarkdownFile('notes/alias.md')).resolves.toBe('# real');
      await expect(repository.readMarkdownFile('notes-alias/real.md')).resolves.toBe('# real');

      // A write through an alias lands on its target; the alias stays a link.
      await repository.updateMarkdownFile('notes/alias.md', '# via alias');
      await expect(readFile(path.join(contentRoot, 'notes/real.md'), 'utf8')).resolves.toBe(
        '# via alias',
      );
      expect((await lstat(path.join(contentRoot, 'notes/alias.md'))).isSymbolicLink()).toBe(true);

      await repository.createMarkdownFile('notes-alias/new.md', '# new');
      await expect(readFile(path.join(contentRoot, 'notes/new.md'), 'utf8')).resolves.toBe('# new');
      const listed = await repository.listTree('notes-alias');
      expect(listed.map((node) => node.path)).toEqual([
        'notes-alias/new.md',
        'notes-alias/real.md',
      ]);

      // Deleting an alias removes the link, never its target.
      await repository.deletePath('notes/alias.md');
      await expect(lstat(path.join(contentRoot, 'notes/alias.md'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(path.join(contentRoot, 'notes/real.md'), 'utf8')).resolves.toBe(
        '# via alias',
      );
    });

    it('lists the tree past broken and looping symlinks, and never lists symlinks', async () => {
      const repository = createFileRepository(createPathResolver(contentRoot));
      await link(path.join(outsideRoot, 'missing.md'), 'notes/dangling.md');
      await link('loop.md', 'loop.md');

      const tree = await repository.listTree('');

      expect(tree.map((node) => node.path)).toEqual(['notes', 'report.html']);
      const notes = tree.find((node) => node.path === 'notes');
      expect(notes?.children?.map((node) => node.path)).toEqual(['notes/real.md']);
    });

    it('deletes a folder holding symlinks by unlinking them, never following them', async () => {
      const repository = createFileRepository(createPathResolver(contentRoot));
      await seed(contentRoot, 'trash/old.md', '# old');
      await link(path.join(outsideRoot, 'secret.md'), 'trash/link.md');
      await link(path.join(outsideRoot, 'dir'), 'trash/linkdir', 'dir');
      const outsideBefore = await snapshotTree(outsideRoot);

      await repository.deletePath('trash', { recursive: true });

      await expect(lstat(path.join(contentRoot, 'trash'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await snapshotTree(outsideRoot)).toEqual(outsideBefore);
    });

    it('works when the vault root itself is reached through a symlink', async () => {
      // e.g. macOS, where os.tmpdir() lives under /var -> /private/var: compare real to real.
      const linkedRoot = path.join(outsideRoot, 'vault-link');
      await symlink(contentRoot, linkedRoot, 'dir');
      const repository = createFileRepository(createPathResolver(linkedRoot));

      await repository.createDirectory('archive');
      await repository.createMarkdownFile('notes/fresh.md', '# fresh');
      await repository.updateMarkdownFile('notes/fresh.md', '# fresher');
      await repository.moveMarkdownFile('notes/fresh.md', 'archive/fresh.md');
      await expect(repository.readMarkdownFile('archive/fresh.md')).resolves.toBe('# fresher');
      await expect(repository.readMarkdownFile('notes/alias.md')).resolves.toBe('# real');
      await repository.deletePath('archive', { recursive: true });
      expect((await repository.listTree('')).map((node) => node.path)).toEqual([
        'notes',
        'report.html',
      ]);

      await expectPathError(repository.readMarkdownFile('notes/escape.md'), OUTSIDE);
    });
  });
});
