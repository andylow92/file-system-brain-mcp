import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry, EditProposal, ProposalAction, VaultEvent } from '@repo/shared';

import type { ProposalStore } from '../storage/proposalStore.js';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

// `POST /api/proposals` (and so the `propose_edit` MCP tool) must apply the same
// markdown-only path rules as every write path *when the proposal is created*.
// Otherwise a proposal for a read-only HTML document, a `.txt` file, a traversal
// path, or the hidden `.fsbrain/` store is accepted, sits in the human's Review
// queue, and only fails with a 400 once they approve it.
describe('POST /api/proposals — markdown-only path validation', () => {
  let contentRoot = '';
  let baseUrl = '';
  let server: http.Server | undefined;
  let proposalStore: ProposalStore;
  let events: VaultEvent[] = [];

  async function api<T>(
    method: string,
    pathname: string,
    options: { body?: unknown; actor?: string } = {},
  ): Promise<{ status: number; body: ApiResponse<T> }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.actor) {
      headers['X-Actor'] = options.actor;
    }
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: (await response.json()) as ApiResponse<T> };
  }

  const propose = (body: Record<string, unknown>) =>
    api<EditProposal>('POST', '/api/proposals', { body, actor: 'agent:test' });

  const approve = (id: string) =>
    api<EditProposal>('POST', '/api/proposals/resolve', { body: { id, decision: 'approve' } });

  beforeEach(async () => {
    contentRoot = await mkdtemp(path.join(os.tmpdir(), 'proposal-paths-root-'));
    process.env.CONTENT_ROOT = contentRoot;
    vi.resetModules();

    const { handleFileRoutes } = await import('./files.js');
    const { createPathResolver } = await import('../storage/pathResolver.js');
    const { createFileRepository } = await import('../storage/fileRepository.js');
    const { createAuditLog } = await import('../storage/auditLog.js');
    const { createProposalStore } = await import('../storage/proposalStore.js');
    const { createQuestionLog } = await import('../storage/questionLog.js');
    const { createIdempotencyCache } = await import('../storage/idempotencyCache.js');
    const { createEventBus } = await import('../events/eventBus.js');
    const { createVaultIndex } = await import('../index/vaultIndex.js');

    // Wire the routes by hand (no file watcher) so the bus only carries events
    // the handlers publish, and the test can inspect the store directly.
    const pathResolver = createPathResolver(contentRoot);
    const repository = createFileRepository(pathResolver);
    const eventBus = createEventBus();
    proposalStore = createProposalStore(contentRoot);
    events = [];
    eventBus.subscribe((event) => events.push(event));
    const deps = {
      repository,
      pathResolver,
      auditLog: createAuditLog(contentRoot),
      proposalStore,
      questionLog: createQuestionLog(contentRoot),
      patchIdempotency: createIdempotencyCache<import('./files.js').PatchFileResponse>(),
      eventBus,
      vaultIndex: createVaultIndex({ repository, eventBus }),
    };

    server = http.createServer(async (req, res) => {
      const handled = await handleFileRoutes(req, res, deps);
      if (!handled.handled) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: { code: 'not_found', message: '' } }));
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, () => resolve()));

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to determine server address');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
    await rm(contentRoot, { recursive: true, force: true });
  });

  const INVALID_PATHS = [
    'report.html', // read-only HTML document
    'report.htm',
    'notes.txt', // non-markdown file
    '../x.md', // traversal out of CONTENT_ROOT
    '.fsbrain/x.md', // the hidden internal store (audit log, proposals)
    '/x.md', // absolute path
  ];
  const ACTIONS: ProposalAction[] = ['create', 'update', 'delete'];
  const CASES = ACTIONS.flatMap((action) =>
    INVALID_PATHS.map((badPath) => [action, badPath] as const),
  );

  it.each(CASES)(
    'rejects a %s proposal for %s with 400, storing and emitting nothing',
    async (action, badPath) => {
      const response = await propose({
        action,
        path: badPath,
        ...(action === 'delete' ? {} : { content: '# Proposed\n' }),
      });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error?.code).toBe('invalid_path');
      // Nothing reached the Review queue (on disk or via the store) or the bus.
      expect(await proposalStore.list()).toEqual([]);
      await expect(stat(path.join(contentRoot, '.fsbrain', 'proposals'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(events).toEqual([]);
    },
  );

  it('still accepts a .md create proposal and applies it end to end on approval', async () => {
    const proposed = await propose({
      action: 'create',
      path: 'notes/plan.md',
      content: '# Plan\n',
      note: 'draft',
    });
    expect(proposed.status).toBe(201);
    expect(proposed.body.data).toMatchObject({
      action: 'create',
      path: 'notes/plan.md',
      actor: 'agent:test',
      status: 'pending',
    });
    expect(await proposalStore.list()).toHaveLength(1);
    expect(events).toEqual([
      expect.objectContaining({ type: 'proposal_created', path: 'notes/plan.md' }),
    ]);

    // A human approves it (actor defaults to `human`).
    const approved = await approve(proposed.body.data!.id);
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({ status: 'approved', resolvedBy: 'human' });

    // The note landed on disk, audited as the proposing agent, with live events.
    expect(await readFile(path.join(contentRoot, 'notes', 'plan.md'), 'utf8')).toBe('# Plan\n');
    const audit = await api<AuditEntry[]>('GET', '/api/audit?path=notes/plan.md');
    expect(audit.body.data?.[0]).toMatchObject({ actor: 'agent:test', action: 'create' });
    expect(events.map((event) => event.type)).toEqual([
      'proposal_created',
      'created',
      'proposal_resolved',
    ]);
  });

  it('still accepts .md update and delete proposals and applies them on approval', async () => {
    await api('POST', '/api/file', { body: { path: 'todo.md', content: 'v1' } });
    const v1 = await api<{ etag: string }>('GET', '/api/file?path=todo.md');

    const update = await propose({
      action: 'update',
      path: 'todo.md',
      content: 'v2',
      baseEtag: v1.body.data!.etag,
    });
    expect(update.status).toBe(201);
    expect((await approve(update.body.data!.id)).status).toBe(200);
    expect(await readFile(path.join(contentRoot, 'todo.md'), 'utf8')).toBe('v2');

    const v2 = await api<{ etag: string }>('GET', '/api/file?path=todo.md');
    const remove = await propose({
      action: 'delete',
      path: 'todo.md',
      baseEtag: v2.body.data!.etag,
    });
    expect(remove.status).toBe(201);
    expect((await approve(remove.body.data!.id)).status).toBe(200);
    await expect(stat(path.join(contentRoot, 'todo.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
