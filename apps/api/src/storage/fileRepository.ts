import { promises as fs } from 'node:fs';
import path from 'node:path';

import { documentFormatForPath, type DocumentFormat } from '@repo/shared';

import { PathResolver, StoragePathError } from './pathResolver.js';

export interface TreeNode {
  name: string;
  isDirectory: boolean;
  path: string;
  lastModified: string;
  /** Document format of a file node; absent on directories. */
  format?: DocumentFormat;
  children?: TreeNode[];
}

export interface DeleteOptions {
  recursive?: boolean;
}

export interface FileRepository {
  createDirectory(logicalPath: string): Promise<void>;
  createMarkdownFile(logicalPath: string, content?: string): Promise<void>;
  readMarkdownFile(logicalPath: string): Promise<string>;
  updateMarkdownFile(logicalPath: string, content: string): Promise<void>;
  moveMarkdownFile(fromLogicalPath: string, toLogicalPath: string): Promise<void>;
  deletePath(logicalPath: string, options?: DeleteOptions): Promise<void>;
  listTree(logicalPath?: string): Promise<TreeNode[]>;
}

export function createFileRepository(pathResolver: PathResolver): FileRepository {
  async function statOrUndefined(absolutePath: string) {
    try {
      return await fs.stat(absolutePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  /** Like `statOrUndefined`, but a symlink (even a broken one) counts as existing. */
  async function lstatOrUndefined(absolutePath: string) {
    try {
      return await fs.lstat(absolutePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * The confined real path (`pathResolver.resolveRealPath`), or `undefined`
   * when nothing real exists there. Every operation on an existing path below
   * resolves it here first (creates use `ensureCreatableInsideRoot`), so a
   * symlink can never carry an operation outside the vault.
   */
  async function realPathOrUndefined(absolutePath: string): Promise<string | undefined> {
    try {
      return await pathResolver.resolveRealPath(absolutePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  /** The real path of an existing markdown note, confined to the vault. */
  async function realMarkdownFilePath(logicalPath: string): Promise<string> {
    const realPath = await realPathOrUndefined(pathResolver.resolveMarkdownPath(logicalPath));
    const stat = realPath === undefined ? undefined : await statOrUndefined(realPath);

    if (realPath === undefined || !stat || !stat.isFile()) {
      throw new StoragePathError('Markdown file does not exist');
    }

    return realPath;
  }

  async function listTree(logicalPath = ''): Promise<TreeNode[]> {
    const basePath = pathResolver.resolvePath(logicalPath);
    const realBasePath = await realPathOrUndefined(basePath);
    const stat = realBasePath === undefined ? undefined : await statOrUndefined(realBasePath);

    if (!stat) {
      throw new StoragePathError('Path does not exist');
    }

    if (!stat.isDirectory()) {
      throw new StoragePathError('Tree listing can only be requested for directories');
    }

    return readTree(basePath);
  }

  async function readTree(basePath: string): Promise<TreeNode[]> {
    const entries = await fs.readdir(basePath, { withFileTypes: true });
    const nodes: TreeNode[] = [];

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // Hidden files/directories (e.g. the `.fsbrain` audit store) are internal
      // and never surfaced in the user-facing tree.
      if (entry.name.startsWith('.')) {
        continue;
      }

      const absolutePath = path.join(basePath, entry.name);
      pathResolver.ensureInsideRoot(absolutePath);

      // `lstat`, not `stat`: never follow a symlink entry, which could point out
      // of the vault, or throw and fail the whole listing if it is broken.
      // Symlinks are skipped below anyway (a `Dirent` is neither a file nor a
      // directory for one), so this only changes how they fail to show up.
      const stat = await fs.lstat(absolutePath);
      const relativePath = path
        .relative(pathResolver.getRootPath(), absolutePath)
        .split(path.sep)
        .join('/');

      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          isDirectory: true,
          path: relativePath,
          lastModified: stat.mtime.toISOString(),
          children: await readTree(absolutePath),
        });
        continue;
      }

      // Supported documents only: markdown notes plus read-only HTML
      // (`.html` / `.htm`). Every other extension stays out of the tree.
      const format = entry.isFile() ? documentFormatForPath(entry.name) : null;
      if (format) {
        nodes.push({
          name: entry.name,
          isDirectory: false,
          path: relativePath,
          lastModified: stat.mtime.toISOString(),
          format,
        });
      }
    }

    return nodes;
  }

  async function createDirectory(logicalPath: string): Promise<void> {
    const absolutePath = pathResolver.resolvePath(logicalPath);
    await pathResolver.ensureCreatableInsideRoot(absolutePath);
    await fs.mkdir(absolutePath, { recursive: true });
  }

  async function createMarkdownFile(logicalPath: string, content = ''): Promise<void> {
    const absolutePath = pathResolver.resolveMarkdownPath(logicalPath);
    await pathResolver.ensureCreatableInsideRoot(absolutePath);
    const existing = await lstatOrUndefined(absolutePath);

    if (existing) {
      throw new StoragePathError('File already exists');
    }

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    try {
      // `wx` is O_CREAT | O_EXCL: it fails instead of following a symlink that
      // appeared after the checks above, and never truncates an existing file.
      await fs.writeFile(absolutePath, content, { encoding: 'utf8', flag: 'wx' });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new StoragePathError('File already exists');
      }
      throw error;
    }
  }

  async function readMarkdownFile(logicalPath: string): Promise<string> {
    return fs.readFile(await realMarkdownFilePath(logicalPath), 'utf8');
  }

  async function updateMarkdownFile(logicalPath: string, content: string): Promise<void> {
    await fs.writeFile(await realMarkdownFilePath(logicalPath), content, 'utf8');
  }

  async function moveMarkdownFile(fromLogicalPath: string, toLogicalPath: string): Promise<void> {
    const sourcePath = pathResolver.resolveMarkdownPath(fromLogicalPath);
    const destinationPath = pathResolver.resolveMarkdownPath(toLogicalPath);

    const realSourcePath = await realPathOrUndefined(sourcePath);
    const sourceStat =
      realSourcePath === undefined ? undefined : await statOrUndefined(realSourcePath);
    if (!sourceStat || !sourceStat.isFile()) {
      throw new StoragePathError('Source markdown file does not exist');
    }

    await pathResolver.ensureCreatableInsideRoot(destinationPath);
    const destinationStat = await lstatOrUndefined(destinationPath);
    if (destinationStat) {
      throw new StoragePathError('Destination already exists');
    }

    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.rename(sourcePath, destinationPath);
  }

  async function deletePath(logicalPath: string, options: DeleteOptions = {}): Promise<void> {
    const normalized = pathResolver.normalizeLogicalPath(logicalPath);
    if (!normalized) {
      throw new StoragePathError('Refusing to delete storage root');
    }

    const absolutePath = pathResolver.resolvePath(normalized);
    const realPath = await realPathOrUndefined(absolutePath);
    const stat = realPath === undefined ? undefined : await statOrUndefined(realPath);

    if (realPath === undefined || !stat) {
      throw new StoragePathError('Path does not exist');
    }

    if (stat.isDirectory()) {
      if (!options.recursive) {
        const entries = await fs.readdir(realPath);
        if (entries.length > 0) {
          throw new StoragePathError('Directory is not empty. Use recursive option to delete it');
        }
      }

      // `rm` removes the entry at the requested path and, when recursive,
      // unlinks any symlinks inside the folder without following them, so
      // nothing outside the vault is ever emptied.
      await fs.rm(absolutePath, { recursive: Boolean(options.recursive), force: false });
      return;
    }

    if (!absolutePath.toLowerCase().endsWith('.md')) {
      throw new StoragePathError('Only .md files can be deleted');
    }

    await fs.unlink(absolutePath);
  }

  return {
    createDirectory,
    createMarkdownFile,
    readMarkdownFile,
    updateMarkdownFile,
    moveMarkdownFile,
    deletePath,
    listTree,
  };
}
