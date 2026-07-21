import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface ContentResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

const ROCKETREACH_TOOLS = [
  'rocketreach_get_account_status',
  'rocketreach_start_intake',
  'rocketreach_search_contacts',
  'rocketreach_lookup_contacts',
];

describe('mcp — RocketReach tools are gated on the integration being enabled', () => {
  let vault = '';
  let bootstrap: typeof import('./server.js').bootstrap;
  let envBackup: { contentRoot?: string; apiBaseUrl?: string; port?: string };

  async function seedEnabled(enabled: boolean, apiKey?: string) {
    await mkdir(path.join(vault, '.fsbrain'), { recursive: true });
    await writeFile(
      path.join(vault, '.fsbrain', 'integrations.json'),
      JSON.stringify({ rocketreach: { enabled, ...(apiKey ? { apiKey } : {}) } }),
    );
  }

  beforeEach(async () => {
    vault = await mkdtemp(path.join(os.tmpdir(), 'mcp-rr-vault-'));
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

  it('does not expose RocketReach tools when the integration is disabled', async () => {
    // No integrations.json at all — the default is disabled.
    const mod = await import('./server.js');
    const { server, context } = await mod.bootstrap();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'rr-off', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const tool of ROCKETREACH_TOOLS) {
        expect(names).not.toContain(tool);
      }
    } finally {
      await client.close();
      await server.close();
      if (context.embeddedServer) {
        await new Promise<void>((resolve) => context.embeddedServer?.close(() => resolve()));
      }
    }
  });

  it('exposes the four RocketReach tools when enabled, and they fail closed once disabled', async () => {
    await seedEnabled(true, 'test-key-1234567');
    const mod = await import('./server.js');
    bootstrap = mod.bootstrap;
    const { server, context } = await bootstrap();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'rr-on', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const tool of ROCKETREACH_TOOLS) {
        expect(names).toContain(tool);
      }

      // Intake is static reference data — it works without spending anything.
      const intake = (await client.callTool({
        name: 'rocketreach_start_intake',
        arguments: {},
      })) as ContentResult;
      expect(intake.isError).not.toBe(true);
      expect(intake.content[0].text).toContain('maxLookups');

      // Now disable the integration out from under the running server. The tool
      // is still registered, but the call must fail closed (no network) because
      // the API re-checks the enabled flag on every request.
      const disable = await fetch(`${context.apiBaseUrl}/api/integrations/rocketreach`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      expect(disable.ok).toBe(true);

      const status = (await client.callTool({
        name: 'rocketreach_get_account_status',
        arguments: {},
      })) as ContentResult;
      expect(status.isError).toBe(true);
      expect(status.content[0].text.toLowerCase()).toContain('disabled');
    } finally {
      await client.close();
      await server.close();
      if (context.embeddedServer) {
        await new Promise<void>((resolve) => context.embeddedServer?.close(() => resolve()));
      }
    }
  });
});
