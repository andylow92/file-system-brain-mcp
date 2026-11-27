/**
 * Shared helpers for the symlink-confinement tests (`storage/__tests__/symlinks.test.ts`,
 * `routes/symlinks.test.ts`): a probe for whether this OS lets the test process create
 * symlinks, and a snapshot of a directory tree that proves a request never touched it.
 */
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * True when this process may create symlinks. Windows refuses without Developer Mode or
 * admin rights; the symlink suites skip there instead of failing.
 */
export function canCreateSymlinks(): boolean {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'symlink-probe-'));
  try {
    symlinkSync(path.join(probe, 'target'), path.join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/**
 * Every entry under `root`, keyed by relative path: a file's bytes and mtime, a symlink's
 * target, or `dir`. Symlinks are recorded, never followed, so two equal snapshots prove
 * nothing under `root` was created, changed, moved, or deleted in between.
 */
export async function snapshotTree(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      const key = path.relative(root, absolutePath).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        entries[key] = `link -> ${await readlink(absolutePath)}`;
      } else if (entry.isDirectory()) {
        entries[key] = 'dir';
        await walk(absolutePath);
      } else {
        const { mtimeMs } = await lstat(absolutePath);
        entries[key] = `${await readFile(absolutePath, 'utf8')} @ ${mtimeMs}`;
      }
    }
  }

  await walk(root);
  return entries;
}
