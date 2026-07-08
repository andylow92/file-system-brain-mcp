import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bootstrap } from './server.js';

interface ContentResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/** Decode the JSON payload our `tool()` wrapper packs into a single text block. */
function decode<T = unknown>(result: ContentResult): T {
  expect(result.isError).not.toBe(true);
  const block = result.content[0];
  expect(block.type).toBe('text');
  return JSON.parse(block.text) as T;
}

describe('mcp server (self-contained)', () => {
  let vault = '';
  let envBackup: { contentRoot?: string; apiBaseUrl?: string; port?: string };

  beforeEach(async () => {
    vault = await mkdtemp(path.join(os.tmpdir(), 'mcp-smoke-vault-'));
    envBackup = {
      contentRoot: process.env.CONTENT_ROOT,
      apiBaseUrl: process.env.API_BASE_URL,
      port: process.env.PORT,
    };
    process.env.CONTENT_ROOT = vault;
    delete process.env.API_BASE_URL;
    delete process.env.PORT;
  });

  afterEach(async () => {
    if (envBackup.contentRoot === undefined) delete process.env.CONTENT_ROOT;
    else process.env.CONTENT_ROOT = envBackup.contentRoot;
    if (envBackup.apiBaseUrl === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = envBackup.apiBaseUrl;
    if (envBackup.port === undefined) delete process.env.PORT;
    else process.env.PORT = envBackup.port;
    await rm(vault, { recursive: true, force: true });
  });

  it('boots an embedded API, registers tools, and round-trips create→read', async () => {
    const { server, context } = await bootstrap();
    expect(context.apiBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(context.embeddedServer).toBeDefined();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'fsbrain-smoke', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const { tools } = await client.listTools();
      const toolNames = tools.map((tool) => tool.name).sort();
      expect(toolNames).toEqual(
        [
          'create_folder',
          'create_note',
          'curate_skills',
          'delete_path',
          'get_backlinks',
          'get_block_anchors',
          'get_context',
          'get_graph',
          'hybrid_search',
          'list_notes',
          'list_proposals',
          'list_skills',
          'move_path',
          'patch_note',
          'proposal_stats',
          'propose_edit',
          'read_block',
          'read_note',
          'recent_activity',
          'recent_questions',
          'run_feedback',
          'run_maintenance',
          'schema_pack',
          'search_notes',
          'semantic_search',
          'think',
          'update_note',
        ].sort(),
      );

      const createResult = (await client.callTool({
        name: 'create_note',
        arguments: { path: 'hello.md', content: '# Hello from a test' },
      })) as ContentResult;
      const created = decode<{ path: string; etag: string }>(createResult);
      expect(created.path).toBe('hello.md');
      expect(created.etag).toBeTypeOf('string');

      const readResult = (await client.callTool({
        name: 'read_note',
        arguments: { path: 'hello.md' },
      })) as ContentResult;
      const read = decode<{ content: string }>(readResult);
      expect(read.content).toBe('# Hello from a test');

      const listResult = (await client.callTool({
        name: 'list_notes',
        arguments: {},
      })) as ContentResult;
      const listed = decode<{ paths: string[] }>(listResult);
      expect(listed.paths).toContain('hello.md');

      // The welcome note should also be present from the empty-vault seed.
      expect(listed.paths).toContain('welcome.md');

      // And the agent write should be attributed in the audit log.
      const auditResult = (await client.callTool({
        name: 'recent_activity',
        arguments: { path: 'hello.md' },
      })) as ContentResult;
      const audit = decode<Array<{ actor: string; action: string }>>(auditResult);
      expect(audit[0]?.actor).toBe('agent:mcp');
      expect(audit[0]?.action).toBe('create');
    } finally {
      await client.close();
      await server.close();
      if (context.embeddedServer) {
        await new Promise<void>((resolve) => context.embeddedServer?.close(() => resolve()));
      }
    }
  });
});
