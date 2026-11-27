import path from 'node:path';

import { documentFormatForPath, type DocumentFormat } from '@repo/shared';

export class StoragePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoragePathError';
  }
}

const INVALID_PATH_SEGMENTS = new Set(['', '.', '..']);

export interface PathResolver {
  getRootPath(): string;
  resolvePath(logicalPath: string): string;
  resolveMarkdownPath(logicalPath: string): string;
  resolveDocumentPath(logicalPath: string): { absolutePath: string; format: DocumentFormat };
  normalizeLogicalPath(logicalPath: string): string;
  ensureInsideRoot(absolutePath: string): void;
}

export function createPathResolver(contentRoot: string | undefined): PathResolver {
  if (!contentRoot) {
    throw new StoragePathError('CONTENT_ROOT must be defined');
  }

  const rootPath = path.resolve(contentRoot);

  function normalizeLogicalPath(logicalPath: string): string {
    if (logicalPath == null) {
      throw new StoragePathError('Path is required');
    }

    const trimmed = logicalPath.trim();
    if (!trimmed) {
      return '';
    }

    const unixLikePath = trimmed.replace(/\\/g, '/');
    if (path.posix.isAbsolute(unixLikePath)) {
      throw new StoragePathError('Absolute paths are not allowed');
    }

    const segments = unixLikePath.split('/');
    for (const segment of segments) {
      if (INVALID_PATH_SEGMENTS.has(segment)) {
        throw new StoragePathError('Path traversal or invalid path segment detected');
      }
      if (segment.includes('\u0000')) {
        throw new StoragePathError('Null byte in path is not allowed');
      }
      // Hidden segments (dotfiles / dot-directories) are reserved for the
      // internal `.fsbrain/` store — audit log, proposals, question log —
      // which is already excluded from `listTree` and the file watcher. If
      // an HTTP-facing route (e.g. `PATCH /api/path`) accepted them we would
      // let unauthenticated callers read/rename/delete the audit trail,
      // silently defeating the provenance + proposal trust boundary
      // (CWE-22). Reject them at the single choke point every logical path
      // flows through.
      if (segment.startsWith('.') && segment !== '.' && segment !== '..') {
        throw new StoragePathError('Hidden path segments are not allowed');
      }
    }

    return path.posix.normalize(unixLikePath);
  }

  function ensureInsideRoot(absolutePath: string): void {
    const relative = path.relative(rootPath, absolutePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new StoragePathError('Requested path is outside of storage root');
    }
  }

  function resolvePath(logicalPath: string): string {
    const normalized = normalizeLogicalPath(logicalPath);
    const absolutePath = path.resolve(rootPath, normalized);
    ensureInsideRoot(absolutePath);
    return absolutePath;
  }

  function resolveMarkdownPath(logicalPath: string): string {
    const normalized = normalizeLogicalPath(logicalPath);
    if (!normalized.toLowerCase().endsWith('.md')) {
      throw new StoragePathError('Only .md files are allowed for this operation');
    }

    const absolutePath = path.resolve(rootPath, normalized);
    ensureInsideRoot(absolutePath);
    return absolutePath;
  }

  /**
   * Resolve a path to any readable vault document — markdown or read-only HTML
   * (see `documentFormatForPath`). Same normalisation and root confinement as
   * `resolveMarkdownPath`; only reads use it, every write stays markdown-only.
   */
  function resolveDocumentPath(logicalPath: string): {
    absolutePath: string;
    format: DocumentFormat;
  } {
    const normalized = normalizeLogicalPath(logicalPath);
    const format = documentFormatForPath(normalized);
    if (!format) {
      throw new StoragePathError('Only .md, .html, or .htm files can be read');
    }

    const absolutePath = path.resolve(rootPath, normalized);
    ensureInsideRoot(absolutePath);
    return { absolutePath, format };
  }

  return {
    getRootPath: () => rootPath,
    resolvePath,
    resolveMarkdownPath,
    resolveDocumentPath,
    normalizeLogicalPath,
    ensureInsideRoot,
  };
}
