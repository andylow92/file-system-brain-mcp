import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MaintenanceFinding, PageType } from '@repo/shared';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

describe('schema pack — GET /api/schema + validation findings', () => {
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

  beforeEach(async () => {
    contentRoot = await mkdtemp(path.join(os.tmpdir(), 'schema-root-'));
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

  it('serves the canonical page types with colours and allowed relations', async () => {
    const result = await api<{ pageTypes: PageType[] }>('GET', '/api/schema');
    expect(result.status).toBe(200);

    const { pageTypes } = result.body.data!;
    const byType = new Map(pageTypes.map((pageType) => [pageType.type, pageType]));
    expect(byType.has('person')).toBe(true);
    expect(byType.has('meeting')).toBe(true);

    const meeting = byType.get('meeting')!;
    expect(meeting.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(meeting.relations.map((rule) => rule.name)).toContain('attendees');
  });

  it('surfaces a schema violation as a maintenance finding (report-only)', async () => {
    // Unknown type + a relation the type is not allowed to declare.
    await seed('ann.md', '---\ntype: unicorn\n---\n# Ann');
    await seed('bob.md', '---\ntype: person\nattendees: [[ann]]\n---\n# Bob');

    const preview = await api<{ findings: MaintenanceFinding[] }>('GET', '/api/maintenance');
    expect(preview.status).toBe(200);

    const schema = preview.body.data!.findings.filter((finding) => finding.kind === 'schema');
    const paths = schema.flatMap((finding) => finding.paths);
    expect(paths).toContain('ann.md'); // unknown_type
    expect(paths).toContain('bob.md'); // disallowed_relation (person has no `attendees`)
    // Report-only: schema findings never carry an auto-fix suggestion.
    expect(schema.every((finding) => finding.suggestion === undefined)).toBe(true);
  });

  it('does not file a proposal for a schema finding on scan', async () => {
    await seed('ann.md', '---\ntype: unicorn\n---\n# Ann');

    const scan = await api<{ findings: MaintenanceFinding[]; proposalsFiled: unknown[] }>(
      'POST',
      '/api/maintenance/scan',
    );
    expect(scan.status).toBe(200);
    expect(scan.body.data!.findings.some((finding) => finding.kind === 'schema')).toBe(true);
    // Report-only findings file nothing; the only proposals (if any) are non-schema.
    expect(scan.body.data!.proposalsFiled).toHaveLength(0);
  });
});
