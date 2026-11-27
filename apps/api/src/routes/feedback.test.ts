import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditProposal, FeedbackFinding } from '@repo/shared';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface ScanResult {
  findings: FeedbackFinding[];
  proposalsFiled: EditProposal[];
}

describe('feedback loop — reviewed draft→final pairs become review proposals', () => {
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

  /** Seed a draft, its final, and a `type: feedback` pairing linking them. */
  const seedPair = async (opts: {
    channel: string;
    slug: string;
    draft: string;
    final: string;
    targetPath?: string;
    reviewReason?: string;
  }) => {
    const draftPath = `social/${opts.channel}/drafts/${opts.slug}.md`;
    const finalPath = `social/${opts.channel}/old-posts/${opts.slug}.md`;
    await seed(draftPath, opts.draft);
    await seed(finalPath, opts.final);
    const fm = [
      '---',
      'type: feedback',
      `channel: ${opts.channel}`,
      `draftPath: ${draftPath}`,
      `finalPath: ${finalPath}`,
      ...(opts.targetPath ? [`targetPath: ${opts.targetPath}`] : []),
      ...(opts.reviewReason ? [`reviewReason: ${opts.reviewReason}`] : []),
      '---',
      'Feedback pairing.',
    ].join('\n');
    await seed(`social/${opts.channel}/feedback/${opts.slug}.md`, fm);
    return { draftPath, finalPath };
  };

  beforeEach(async () => {
    contentRoot = await mkdtemp(path.join(os.tmpdir(), 'feedback-root-'));
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

  it('GET /api/feedback is a dry preview — it finds the pair but files nothing', async () => {
    await seedPair({
      channel: 'x',
      slug: 'launch',
      draft:
        '# Launch\n\nEigenoid makes you compliant instantly. Sign up now for the best on the market.',
      final: '# Launch\n\nAudit evidence, mapped. Lead with the workflow pain.',
    });

    const preview = await api<{ findings: FeedbackFinding[] }>('GET', '/api/feedback');
    expect(preview.status).toBe(200);
    const finding = preview.body.data!.findings.find((f) => f.channel === 'x');
    expect(finding?.suggestion?.action).toBe('create');
    expect(finding?.suggestion?.path).toBe('feedback/x.md');

    // A preview files nothing.
    const proposals = await api<EditProposal[]>('GET', '/api/proposals');
    expect(proposals.body.data).toEqual([]);
  });

  it('POST /api/feedback/scan files an attributed proposal and is idempotent on re-scan', async () => {
    await seedPair({
      channel: 'x',
      slug: 'launch',
      draft:
        '# Launch\n\nEigenoid makes you compliant instantly. Sign up now, the best on the market.',
      final: '# Launch\n\nAudit evidence, mapped. Lead with the workflow pain.',
      reviewReason: 'Avoid claiming we make customers compliant; say audit evidence map.',
    });

    const first = await api<ScanResult>('POST', '/api/feedback/scan');
    expect(first.status).toBe(200);
    expect(first.body.data!.proposalsFiled).toHaveLength(1);

    const proposal = first.body.data!.proposalsFiled[0];
    expect(proposal.actor).toBe('agent:feedback-loop');
    expect(proposal.action).toBe('create');
    expect(proposal.path).toBe('feedback/x.md');
    // The human's review reason rides onto the proposed lesson + note.
    expect(proposal.note).toContain('audit evidence map');
    expect(proposal.content).toContain('Avoid claiming we make customers compliant');
    expect(proposal.content).toContain('type: skill');

    // Re-running files nothing new — the pending proposal blocks the same fix.
    const second = await api<ScanResult>('POST', '/api/feedback/scan');
    expect(second.body.data!.proposalsFiled).toHaveLength(0);

    const proposals = await api<EditProposal[]>('GET', '/api/proposals');
    expect(proposals.body.data).toHaveLength(1);
  });

  it('files a proposal for each of x, linkedin, and email drafts', async () => {
    await seedPair({
      channel: 'x',
      slug: 'launch',
      draft: '# x\n\nLong salesy X draft that goes on and on about the platform.',
      final: '# x\n\nTight X post.',
    });
    await seedPair({
      channel: 'linkedin',
      slug: 'intro',
      draft:
        '# li\n\nGeneric broad Eigenoid pitch with no specific workflow pain mentioned at all.',
      final: '# li\n\nNoticed your audit-evidence workflow pain — worth a quick chat?',
      reviewReason: 'Too generic; mention the specific workflow pain first.',
    });
    await seedPair({
      channel: 'email',
      slug: 'advisor',
      draft:
        '# em\n\nLong advisor email with attached architecture detail nobody asked for, plus a broad pitch.',
      final: '# em\n\nOne clear ask, under 120 words.',
    });

    const scan = await api<ScanResult>('POST', '/api/feedback/scan');
    const targets = scan.body.data!.proposalsFiled.map((p) => p.path).sort();
    expect(targets).toEqual(['feedback/email.md', 'feedback/linkedin.md', 'feedback/x.md']);
    expect(scan.body.data!.proposalsFiled.every((p) => p.actor === 'agent:feedback-loop')).toBe(
      true,
    );
  });

  it('never files a lesson against a targetPath outside the markdown write rules', async () => {
    // A free-text `targetPath` that escapes the vault or points into the hidden
    // `.fsbrain/` store could only 400 on approval, so it is reported, not filed.
    await seedPair({
      channel: 'x',
      slug: 'launch',
      draft: '# x\n\nLong salesy X draft that goes on and on about the platform.',
      final: '# x\n\nTight X post.',
      targetPath: '../escape',
    });
    await seedPair({
      channel: 'email',
      slug: 'advisor',
      draft: '# em\n\nLong advisor email with a broad pitch nobody asked for.',
      final: '# em\n\nOne clear ask.',
      targetPath: '.fsbrain/playbook',
    });
    await seedPair({
      channel: 'linkedin',
      slug: 'intro',
      draft: '# li\n\nGeneric broad pitch with no specific workflow pain mentioned.',
      final: '# li\n\nNoticed your audit-evidence workflow pain — worth a quick chat?',
    });

    const scan = await api<ScanResult>('POST', '/api/feedback/scan');
    expect(scan.status).toBe(200);
    const suggested = scan.body.data!.findings.map((f) => f.suggestion?.path).sort();
    expect(suggested).toEqual(['../escape.md', '.fsbrain/playbook.md', 'feedback/linkedin.md']);
    expect(scan.body.data!.proposalsFiled.map((p) => p.path)).toEqual(['feedback/linkedin.md']);
  });
});
