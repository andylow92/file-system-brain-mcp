/**
 * Agents reach the vault only through these MCP tools, which call the embedded
 * storage API. This proves the API's symlink confinement holds end to end: a
 * symlink that leaves the vault can't be read or written with `read_note`,
 * `update_note`, `patch_note`, or `create_note`, while a symlink that stays
 * inside the vault still reads. Skipped where the OS refuses to create
 * symlinks (Windows without Developer Mode).
 */
import { mkdtempSync, promises as fs, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.resolve(here, '..', '..');
const repoRoot = path.resolve(mcpRoot, '..', '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const serverEntry = path.join(mcpRoot, 'src', 'server.ts');

interface ContentResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function canCreateSymlinks(): boolean {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'symlink-probe-'));
  try {
    symlinkSync(path.join(probe, 'target'), path.join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

describe.skipIf(!canCreateSymlinks())('MCP tools stay inside the vault', () => {
  let vault = '';
  let outside = '';
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;

  beforeEach(async () => {
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'fsbrain-symlink-vault-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'fsbrain-symlink-outside-'));
    await fs.writeFile(path.join(outside, 'secret.md'), '# outside secret', 'utf8');
    await fs.mkdir(path.join(outside, 'dir'));
    await fs.mkdir(path.join(vault, 'notes'));
    await fs.writeFile(path.join(vault, 'notes', 'real.md'), '# real', 'utf8');
    await fs.symlink(path.join(outside, 'secret.md'), path.join(vault, 'notes', 'escape.md'));
    await fs.symlink(path.join(outside, 'dir'), path.join(vault, 'linkdir'), 'dir');
    await fs.symlink('real.md', path.join(vault, 'notes', 'alias.md'));
  });

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => undefined);
      client = undefined;
    }
    if (transport) {
      await transport.close().catch(() => undefined);
      transport = undefined;
    }
    await fs.rm(vault, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('refuses to read or write through a symlink that leaves the vault', async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxCli, serverEntry],
      env: {
        ...process.env,
        CONTENT_ROOT: vault,
        API_BASE_URL: '',
        MCP_ACTOR: 'agent:symlink-test',
      },
      stderr: 'inherit',
    });
    client = new Client({ name: 'symlink-confinement-test', version: '0.0.0' });
    await client.connect(transport);

    const attempts: Array<[string, Record<string, unknown>]> = [
      ['read_note', { path: 'notes/escape.md' }],
      ['update_note', { path: 'notes/escape.md', content: 'clobbered by an agent' }],
      ['patch_note', { path: 'notes/escape.md', op: { type: 'append', text: 'appended' } }],
      ['create_note', { path: 'linkdir/planted.md', content: 'planted by an agent' }],
    ];
    for (const [name, args] of attempts) {
      const result = (await client.callTool({ name, arguments: args })) as ContentResult;
      expect({ name, isError: result.isError }).toEqual({ name, isError: true });
      expect(result.content[0]?.text, name).toMatch(/resolves outside of storage root/);
      expect(result.content[0]?.text, name).not.toContain('outside secret');
    }

    await expect(fs.readFile(path.join(outside, 'secret.md'), 'utf8')).resolves.toBe(
      '# outside secret',
    );
    await expect(fs.readdir(path.join(outside, 'dir'))).resolves.toEqual([]);

    // A symlink that stays inside the vault is still an ordinary, readable note.
    const alias = (await client.callTool({
      name: 'read_note',
      arguments: { path: 'notes/alias.md' },
    })) as ContentResult;
    expect(alias.isError).not.toBe(true);
    expect(JSON.parse(alias.content[0]!.text)).toMatchObject({
      path: 'notes/alias.md',
      content: '# real',
    });
  });
});
