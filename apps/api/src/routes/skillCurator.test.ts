import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, utimes } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditProposal, SkillCuratorFinding } from '@repo/shared';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

describe('skill curator — GET /api/skills/curator (report-only)', () => {
  let contentRoot = '';
  let baseUrl = '';
  let server: http.Server | undefined;

  async function api<T>(
    method: string,
    pathname: string,
    options: { body?: unknown } = {},
  ): Promise<{ status: number; body: ApiResponse<T> }> {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: (await response.json()) as ApiResponse<T> };
  }

  const seed = (notePath: string, content: string) =>
    api('POST', '/api/file', { body: { path: notePath, content } });

  const completeSkill = (title: string, body: string) =>
    [
      '---',
      'type: skill',
      `name: ${title}`,
      '---',
      `# ${title}`,
      '## When to Use',
      body,
      '## Procedure',
      '1. Step.',
      '## Pitfalls',
      '- Careful.',
      '## Verification',
      'Confirm.',
      '',
    ].join('\n');

  beforeEach(async () => {
    contentRoot = await mkdtemp(path.join(os.tmpdir(), 'curator-root-'));
    process.env.CONTENT_ROOT = contentRoot;
    vi.resetModules();

    const { createServer } = await import('../server.js');
    server = createServer();
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

  it('flags an incomplete skill and suggests appending section stubs — but files nothing', async () => {
    await seed(
      'skills/deploy.md',
      '---\ntype: skill\nname: Deploy\n---\n# Deploy\nRun the script.',
    );

    const preview = await api<{ findings: SkillCuratorFinding[] }>('GET', '/api/skills/curator');
    expect(preview.status).toBe(200);

    const incomplete = preview.body.data!.findings.filter((f) => f.kind === 'incomplete');
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].paths).toEqual(['skills/deploy.md']);
    expect(incomplete[0].suggestion!.action).toBe('update');
    expect(incomplete[0].suggestion!.content).toContain('## Verification');

    // Report-only: nothing lands in the Review queue.
    const pending = await api<EditProposal[]>('GET', '/api/proposals?status=pending');
    expect(pending.body.data).toEqual([]);
  });

  it('ignores non-skill notes', async () => {
    await seed('notes/plain.md', '# Plain\njust a note, no frontmatter type');

    const preview = await api<{ findings: SkillCuratorFinding[] }>('GET', '/api/skills/curator');
    expect(preview.body.data!.findings).toEqual([]);
  });

  it('reports a stale skill using file mtime, honoring the staleAfterDays query param', async () => {
    await seed(
      'skills/old.md',
      completeSkill('Old', 'A complete but ancient playbook with unique wording xyzzy.'),
    );

    // Age the file well past the window via utimes.
    const old = new Date('2026-01-01T00:00:00Z');
    await utimes(path.join(contentRoot, 'skills', 'old.md'), old, old);

    const preview = await api<{ findings: SkillCuratorFinding[] }>(
      'GET',
      '/api/skills/curator?staleAfterDays=30',
    );
    const stale = preview.body.data!.findings.filter((f) => f.kind === 'stale_skill');
    expect(stale).toHaveLength(1);
    expect(stale[0].paths).toEqual(['skills/old.md']);
  });

  it('exempts a pinned skill from stale flags', async () => {
    await seed(
      'skills/pinned.md',
      completeSkill('Pinned', 'A complete pinned playbook with unique wording xyzzy.').replace(
        'type: skill',
        'type: skill\npinned: true',
      ),
    );
    const old = new Date('2026-01-01T00:00:00Z');
    await utimes(path.join(contentRoot, 'skills', 'pinned.md'), old, old);

    const preview = await api<{ findings: SkillCuratorFinding[] }>(
      'GET',
      '/api/skills/curator?staleAfterDays=30',
    );
    expect(preview.body.data!.findings.filter((f) => f.kind === 'stale_skill')).toHaveLength(0);
  });
});
