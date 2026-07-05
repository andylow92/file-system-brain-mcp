import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ApiError {
  code: string;
  message: string;
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
}

// Regression tests for CWE-22 in PATCH /api/path.
//
// The rename endpoint checks `.md` only on the file branch — when the source
// is a directory, it falls through to `pathResolver.resolvePath()` +
// `fs.rename()`, which happily moves any directory reachable inside
// CONTENT_ROOT. The `.fsbrain/` internal store (audit log, proposals,
// question log) lives inside CONTENT_ROOT because `auditLog.ts` /
// `proposalStore.ts` / `questionLog.ts` write with plain `path.join`,
// bypassing the resolver. So an unauthenticated
// `PATCH /api/path {fromPath:".fsbrain", toPath:"trash"}` request moves the
// audit trail — silently defeating the audit + proposal trust boundary.
//
// After the fix, `pathResolver.normalizeLogicalPath` must reject any logical
// path whose segments include a dotfile/dot-directory (matching the same
// exclusion already applied by `listTree` and the file-system watcher).
describe('PATCH /api/path — dotfile source guard (CWE-22 regression)', () => {
  let contentRoot = '';
  let baseUrl = '';
  let server: http.Server | undefined;

  async function createRouteDependencies(rootPath: string) {
    const { createPathResolver } = await import('../storage/pathResolver.js');
    const { createFileRepository } = await import('../storage/fileRepository.js');
    const { createAuditLog } = await import('../storage/auditLog.js');
    const { createProposalStore } = await import('../storage/proposalStore.js');
    const { createQuestionLog } = await import('../storage/questionLog.js');
    const { createIdempotencyCache } = await import('../storage/idempotencyCache.js');
    const { createEventBus } = await import('../events/eventBus.js');
    const { createVaultIndex } = await import('../index/vaultIndex.js');
    const pathResolver = createPathResolver(rootPath);
    const repository = createFileRepository(pathResolver);
    const auditLog = createAuditLog(rootPath);
    const proposalStore = createProposalStore(rootPath);
    const questionLog = createQuestionLog(rootPath);
    const patchIdempotency = createIdempotencyCache<import('./files.js').PatchFileResponse>();
    const eventBus = createEventBus();
    const vaultIndex = createVaultIndex({ repository, eventBus });
    return {
      repository,
      pathResolver,
      auditLog,
      proposalStore,
      questionLog,
      patchIdempotency,
      eventBus,
      vaultIndex,
    };
  }

  beforeEach(async () => {
    contentRoot = await mkdtemp(path.join(os.tmpdir(), 'api-routes-content-root-'));
    process.env.CONTENT_ROOT = contentRoot;
    vi.resetModules();

    const { handleFileRoutes } = await import('./files.js');
    const deps = await createRouteDependencies(contentRoot);

    server = http.createServer(async (req, res) => {
      const handled = await handleFileRoutes(req, res, deps);
      if (!handled.handled) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            success: false,
            error: { code: 'not_found', message: 'Endpoint not found.' },
          }),
        );
      }
    });

    await new Promise<void>((resolve) => {
      server!.listen(0, () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to determine server address for tests');
    }

    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    await rm(contentRoot, { recursive: true, force: true });
  });

  async function patchPath(fromPath: string, toPath: string): Promise<Response> {
    return fetch(`${baseUrl}/api/path`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromPath, toPath }),
    });
  }

  it('refuses to move the hidden .fsbrain audit directory', async () => {
    // Plant a realistic .fsbrain tree so the pre-fix code path (which stats
    // the source and takes the directory branch) can execute.
    await mkdir(path.join(contentRoot, '.fsbrain', 'proposals'), { recursive: true });
    await writeFile(
      path.join(contentRoot, '.fsbrain', 'audit.jsonl'),
      '{"ts":"2024-01-01T00:00:00Z","actor":"human","action":"create","path":"a.md"}\n',
      'utf8',
    );
    await writeFile(
      path.join(contentRoot, '.fsbrain', 'proposals', 'p-1.json'),
      '{"status":"pending"}',
      'utf8',
    );

    const response = await patchPath('.fsbrain', 'trash');
    const body = (await response.json()) as ApiResponse<unknown>;

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('invalid_path');

    // The audit trail must remain untouched.
    await expect(stat(path.join(contentRoot, '.fsbrain'))).resolves.toMatchObject({});
    await expect(
      readFile(path.join(contentRoot, '.fsbrain', 'audit.jsonl'), 'utf8'),
    ).resolves.toContain('human');
    await expect(stat(path.join(contentRoot, 'trash'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to move a nested hidden segment (.fsbrain/proposals)', async () => {
    await mkdir(path.join(contentRoot, '.fsbrain', 'proposals'), { recursive: true });
    await writeFile(
      path.join(contentRoot, '.fsbrain', 'proposals', 'p-1.json'),
      '{"status":"pending"}',
      'utf8',
    );

    const response = await patchPath('.fsbrain/proposals', 'exposed-proposals');
    const body = (await response.json()) as ApiResponse<unknown>;

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('invalid_path');

    await expect(stat(path.join(contentRoot, '.fsbrain', 'proposals'))).resolves.toMatchObject({});
    await expect(stat(path.join(contentRoot, 'exposed-proposals'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses to move any path into a hidden destination', async () => {
    // A hidden destination lets an attacker plant a proposal or overwrite
    // audit entries via a subsequent /api/file write; must be rejected too.
    await mkdir(path.join(contentRoot, 'notes'), { recursive: true });
    await writeFile(path.join(contentRoot, 'notes/source.md'), '# source', 'utf8');

    const response = await patchPath('notes/source.md', '.fsbrain/planted.md');
    const body = (await response.json()) as ApiResponse<unknown>;

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('invalid_path');

    await expect(readFile(path.join(contentRoot, 'notes/source.md'), 'utf8')).resolves.toBe(
      '# source',
    );
    await expect(stat(path.join(contentRoot, '.fsbrain', 'planted.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects the Windows-separator variant that smuggles a hidden segment', async () => {
    // `normalizeLogicalPath` collapses `\` -> `/` before segmenting, so this
    // variant must be caught by the same guard rather than slipping past
    // because the raw string happens to be a single "segment".
    await mkdir(path.join(contentRoot, '.fsbrain', 'proposals'), { recursive: true });
    await writeFile(
      path.join(contentRoot, '.fsbrain', 'proposals', 'p-1.json'),
      '{"status":"pending"}',
      'utf8',
    );

    const response = await patchPath('.fsbrain\\proposals', 'exposed');
    const body = (await response.json()) as ApiResponse<unknown>;

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('invalid_path');

    await expect(stat(path.join(contentRoot, '.fsbrain', 'proposals'))).resolves.toMatchObject({});
    await expect(stat(path.join(contentRoot, 'exposed'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('still permits ordinary directory renames after the fix', async () => {
    // Regression guard: the visible-tree behaviour from the existing test
    // suite (files.test.ts "still supports directory moves") must survive.
    await mkdir(path.join(contentRoot, 'docs/guides'), { recursive: true });
    await writeFile(path.join(contentRoot, 'docs/guides/intro.md'), '# intro', 'utf8');

    const response = await patchPath('docs', 'archive/docs');
    const body = (await response.json()) as ApiResponse<{ fromPath: string; toPath: string }>;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ fromPath: 'docs', toPath: 'archive/docs' });
  });
});
