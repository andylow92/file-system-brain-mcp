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

  async function listTree(logicalPath = ''): Promise<TreeNode[]> {
    const basePath = pathResolver.resolvePath(logicalPath);
    const stat = await statOrUndefined(basePath);

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

      const stat = await fs.stat(absolutePath);
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
    await fs.mkdir(absolutePath, { recursive: true });
  }

  async function createMarkdownFile(logicalPath: string, content = ''): Promise<void> {
    const absolutePath = pathResolver.resolveMarkdownPath(logicalPath);
    const existing = await statOrUndefined(absolutePath);

    if (existing) {
      throw new StoragePathError('File already exists');
    }

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, 'utf8');
  }

  async function readMarkdownFile(logicalPath: string): Promise<string> {
    const absolutePath = pathResolver.resolveMarkdownPath(logicalPath);
    const stat = await statOrUndefined(absolutePath);

    if (!stat || !stat.isFile()) {
      throw new StoragePathError('Markdown file does not exist');
    }

    return fs.readFile(absolutePath, 'utf8');
  }

  async function updateMarkdownFile(logicalPath: string, content: string): Promise<void> {
    const absolutePath = pathResolver.resolveMarkdownPath(logicalPath);
    const stat = await statOrUndefined(absolutePath);

    if (!stat || !stat.isFile()) {
      throw new StoragePathError('Markdown file does not exist');
    }

    await fs.writeFile(absolutePath, content, 'utf8');
  }

  async function moveMarkdownFile(fromLogicalPath: string, toLogicalPath: string): Promise<void> {
    const sourcePath = pathResolver.resolveMarkdownPath(fromLogicalPath);
    const destinationPath = pathResolver.resolveMarkdownPath(toLogicalPath);

    const sourceStat = await statOrUndefined(sourcePath);
    if (!sourceStat || !sourceStat.isFile()) {
      throw new StoragePathError('Source markdown file does not exist');
    }

    const destinationStat = await statOrUndefined(destinationPath);
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
    const stat = await statOrUndefined(absolutePath);

    if (!stat) {
      throw new StoragePathError('Path does not exist');
    }

    if (stat.isDirectory()) {
      if (!options.recursive) {
        const entries = await fs.readdir(absolutePath);
        if (entries.length > 0) {
          throw new StoragePathError('Directory is not empty. Use recursive option to delete it');
        }
      }

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
