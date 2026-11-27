import { promises as fs } from 'node:fs';
import path from 'node:path';

import { documentFormatForPath, type DocumentFormat } from '@repo/shared';

export class StoragePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoragePathError';
  }
}

const INVALID_PATH_SEGMENTS = new Set(['', '.', '..']);

/** True when a `path.relative(base, target)` result climbs out of `base`. */
function isOutside(relativePath: string): boolean {
  return relativePath.startsWith('..') || path.isAbsolute(relativePath);
}

export interface PathResolver {
  getRootPath(): string;
  resolvePath(logicalPath: string): string;
  resolveMarkdownPath(logicalPath: string): string;
  resolveDocumentPath(logicalPath: string): { absolutePath: string; format: DocumentFormat };
  normalizeLogicalPath(logicalPath: string): string;
  ensureInsideRoot(absolutePath: string): void;
  /**
   * Follow every symlink in an existing path and return its real location,
   * which must still be a valid vault path. Rejects with `ENOENT` when nothing
   * real is there.
   */
  resolveRealPath(absolutePath: string): Promise<string>;
  /** Confine a path about to be created through its nearest existing ancestor. */
  ensureCreatableInsideRoot(absolutePath: string): Promise<void>;
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
    if (isOutside(path.relative(rootPath, absolutePath))) {
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

  // Everything above is lexical: it judges how a path is spelled. A symlink in
  // the vault can still point anywhere, and `fs.stat` / `readFile` / `writeFile`
  // follow it, so each existing path is also resolved with `realpath` and judged
  // by where it really is. Real is compared with real, because CONTENT_ROOT may
  // itself sit under a symlink (macOS `/tmp` -> `/private/tmp`).
  let realRootPromise: Promise<string> | undefined;

  /** The root's real path, resolved once on first use. */
  function getRealRoot(): Promise<string> {
    if (!realRootPromise) {
      const pending = fs.realpath(rootPath);
      realRootPromise = pending;
      // Never cache a failure: the root may just not exist yet.
      pending.catch(() => {
        if (realRootPromise === pending) {
          realRootPromise = undefined;
        }
      });
    }
    return realRootPromise;
  }

  /**
   * Resolve every symlink in `absolutePath` (a lexically confined path, as the
   * `resolve*Path` methods return) and return its real location. That location
   * must pass the rules the requested path passed: inside the real root, no
   * hidden segment, and the same document format. A symlink can therefore only
   * give a second name to a file the API already serves under its own name. It
   * can never reach out of the vault or into `.fsbrain/`, or make read-only HTML
   * writable under a `.md` name. When nothing real is there (a missing file or
   * a broken symlink) this rejects with `ENOENT`, so callers keep their 404s.
   */
  async function resolveRealPath(absolutePath: string): Promise<string> {
    ensureInsideRoot(absolutePath);
    const realRootPath = await getRealRoot();
    const realPath = await fs.realpath(absolutePath);

    const realRelativePath = path.relative(realRootPath, realPath);
    if (isOutside(realRelativePath)) {
      throw new StoragePathError('Requested path resolves outside of storage root');
    }

    let realLogicalPath: string | undefined;
    try {
      // The same rules as a requested path, which rejects a hidden segment.
      realLogicalPath = normalizeLogicalPath(realRelativePath);
    } catch {
      realLogicalPath = undefined;
    }
    const requestedFormat = documentFormatForPath(path.relative(rootPath, absolutePath));
    if (
      realLogicalPath === undefined ||
      documentFormatForPath(realLogicalPath) !== requestedFormat
    ) {
      throw new StoragePathError(
        'Requested path resolves to a hidden path or a different file type',
      );
    }
    return realPath;
  }

  /**
   * Confine a path that is about to be created: a note, a folder, or a move
   * destination. Nothing may exist there yet, so walk up to the nearest entry
   * that does and require it to pass `resolveRealPath`. Otherwise `mkdir -p` and
   * the create itself would follow a symlinked folder out of the vault. A broken
   * symlink on the way is refused as well, because a create would follow it to
   * wherever it points.
   */
  async function ensureCreatableInsideRoot(absolutePath: string): Promise<void> {
    // Terminates: past the root, `resolveRealPath`'s lexical check throws.
    for (let candidate = absolutePath; ; candidate = path.dirname(candidate)) {
      try {
        await resolveRealPath(candidate);
        return;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      const isBrokenSymlink = await fs.lstat(candidate).then(
        () => true,
        () => false,
      );
      if (isBrokenSymlink) {
        throw new StoragePathError('Requested path goes through a broken symlink');
      }
    }
  }

  return {
    getRootPath: () => rootPath,
    resolvePath,
    resolveMarkdownPath,
    resolveDocumentPath,
    normalizeLogicalPath,
    ensureInsideRoot,
    resolveRealPath,
    ensureCreatableInsideRoot,
  };
}
