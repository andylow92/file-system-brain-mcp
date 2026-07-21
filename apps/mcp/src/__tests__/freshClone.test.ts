/**
 * Fresh-clone end-to-end test for the MCP server.
 *
 * The proof that "tell an agent to clone the repo and use the brain" works:
 * the first test spawns the self-contained MCP server as a real stdio child
 * process (via `tsx` so no prior `npm run build` is required), drives it via
 * the real MCP SDK client, and asserts the write landed both on disk and in
 * the audit log.
 *
 * The second test exercises the bundled bin (`dist/server.js`) when it
 * exists: spawns it via `node`, drives a `tools/list` round-trip, and
 * asserts the readiness banner. It's skipped silently if `npm run build`
 * hasn't been run, so `npm test` doesn't fail on a clean checkout.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  AnswerKit,
  AuditEntry,
  EditProposal,
  HybridHit,
  SearchMatch,
  SemanticHit,
} from '@repo/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.resolve(here, '..', '..');
const repoRoot = path.resolve(mcpRoot, '..', '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const serverEntry = path.join(mcpRoot, 'src', 'server.ts');

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

describe('fresh-clone MCP end-to-end', () => {
  let vault = '';
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;

  beforeEach(async () => {
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'fsbrain-fresh-clone-'));
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
  });

  it('boots from a temp vault, lists tools, round-trips writes, and records provenance', async () => {
    transport = new StdioClientTransport({
      // Drive the bin via tsx so the test doesn't depend on a prior `npm run build`.
      // A separate guarantee (npm script + bin field) covers the bundled `dist/server.js` path.
      command: process.execPath,
      args: [tsxCli, serverEntry],
      // Force the embedded-API mode and point it at our temp vault.
      env: {
        ...process.env,
        CONTENT_ROOT: vault,
        API_BASE_URL: '',
        MCP_ACTOR: 'agent:fresh-clone',
      },
      // Surface server stderr (readiness banner, errors) on the test runner stderr.
      stderr: 'inherit',
    });
    client = new Client({ name: 'fresh-clone-test', version: '0.0.0' });
    await client.connect(transport);

    // 1) tools/list — assert the expected tool surface is present.
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

    // 2) create_note → read_note round-trip.
    const createResult = (await client.callTool({
      name: 'create_note',
      arguments: {
        path: 'notes/idea.md',
        content: '# Brainstorm\n\nKey idea: vaults can serve agents and humans equally.\n',
      },
    })) as ContentResult;
    const created = decode<{ path: string; etag: string }>(createResult);
    expect(created.path).toBe('notes/idea.md');
    expect(created.etag).toBeTypeOf('string');

    const readResult = (await client.callTool({
      name: 'read_note',
      arguments: { path: 'notes/idea.md' },
    })) as ContentResult;
    const read = decode<{ content: string }>(readResult);
    expect(read.content).toContain('Key idea');

    // 3) The write must land on disk under the temp CONTENT_ROOT.
    const onDisk = await fs.readFile(path.join(vault, 'notes', 'idea.md'), 'utf8');
    expect(onDisk).toContain('Key idea');

    // 3a) The empty-vault seed should have created welcome.md.
    await expect(fs.access(path.join(vault, 'welcome.md'))).resolves.toBeUndefined();

    // 4) search_notes should find the new note.
    const searchResult = (await client.callTool({
      name: 'search_notes',
      arguments: { query: 'brainstorm' },
    })) as ContentResult;
    const matches = decode<SearchMatch[]>(searchResult);
    expect(matches.map((match) => match.path)).toContain('notes/idea.md');

    // 5) semantic_search should also find it.
    const semanticResult = (await client.callTool({
      name: 'semantic_search',
      arguments: { query: 'vault for agents and humans', limit: 5 },
    })) as ContentResult;
    const hits = decode<SemanticHit[]>(semanticResult);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((hit) => hit.path)).toContain('notes/idea.md');

    // 5b) hybrid_search fuses keyword + semantic ranking and finds it too.
    const hybridResult = (await client.callTool({
      name: 'hybrid_search',
      arguments: { query: 'brainstorm vault for agents', limit: 5 },
    })) as ContentResult;
    const hybridHits = decode<HybridHit[]>(hybridResult);
    expect(hybridHits.map((hit) => hit.path)).toContain('notes/idea.md');
    expect(hybridHits.every((hit) => hit.sources.length > 0)).toBe(true);

    // 5c) think returns a cited answer kit + offline gap analysis (no key needed).
    const thinkResult = (await client.callTool({
      name: 'think',
      arguments: { query: 'can the vault serve agents and humans?' },
    })) as ContentResult;
    const kit = decode<AnswerKit>(thinkResult);
    expect(kit.citations.length).toBeGreaterThan(0);
    expect(kit.citations.map((c) => c.path)).toContain('notes/idea.md');
    // Citation numbers map onto the gathered passages.
    expect(kit.citations.map((c) => c.n)).toEqual(kit.passages.map((_, i) => i + 1));
    // The deterministic gap analysis is present and offline (no synthesized answer).
    expect(kit.gaps).toHaveProperty('uncoveredTerms');
    expect((kit as AnswerKit & { answer?: string }).answer).toBeUndefined();

    // 6) propose_edit + list_proposals — agent-driven review queue.
    const proposeResult = (await client.callTool({
      name: 'propose_edit',
      arguments: {
        action: 'update',
        path: 'notes/idea.md',
        content: '# Brainstorm\n\nRefined: vaults can serve agents and humans equally.\n',
        baseEtag: created.etag,
        note: 'tighter wording',
      },
    })) as ContentResult;
    const proposal = decode<EditProposal>(proposeResult);
    expect(proposal.status).toBe('pending');
    expect(proposal.actor).toBe('agent:fresh-clone');

    const proposalsResult = (await client.callTool({
      name: 'list_proposals',
      arguments: { status: 'pending' },
    })) as ContentResult;
    const proposals = decode<EditProposal[]>(proposalsResult);
    expect(proposals.map((p) => p.id)).toContain(proposal.id);

    // 7) recent_activity exposes the audit log via MCP and matches the on-disk log.
    const auditResult = (await client.callTool({
      name: 'recent_activity',
      arguments: { path: 'notes/idea.md' },
    })) as ContentResult;
    const audit = decode<AuditEntry[]>(auditResult);
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0].actor).toBe('agent:fresh-clone');
    expect(audit[0].action).toBe('create');
    expect(audit[0].path).toBe('notes/idea.md');

    const auditFile = path.join(vault, '.fsbrain', 'audit.jsonl');
    const auditRaw = await fs.readFile(auditFile, 'utf8');
    const auditLines = auditRaw.trim().split('\n').filter(Boolean);
    expect(auditLines.length).toBeGreaterThan(0);
    const lastEntry = JSON.parse(auditLines[auditLines.length - 1]) as AuditEntry;
    expect(lastEntry.actor).toBe('agent:fresh-clone');
    expect(lastEntry.path).toBe('notes/idea.md');

    // 8) run_maintenance — the dream cycle. Seed a note with a broken link,
    // kick the scan, and assert the missing target was filed as a pending
    // proposal (attributed to agent:maintenance) that surfaces in the Review
    // queue. Resolution stays human-only — the scan only proposes.
    await client.callTool({
      name: 'create_note',
      arguments: { path: 'links.md', content: '# Links\nThis points at [[missing-note]].\n' },
    });
    const maintenanceResult = (await client.callTool({
      name: 'run_maintenance',
      arguments: {},
    })) as ContentResult;
    const maintenance = decode<{
      findings: Array<{ kind: string }>;
      proposalsFiled: EditProposal[];
    }>(maintenanceResult);
    expect(maintenance.findings.some((finding) => finding.kind === 'broken_link')).toBe(true);
    const stub = maintenance.proposalsFiled.find((p) => p.path === 'missing-note.md');
    expect(stub).toBeDefined();
    expect(stub!.action).toBe('create');
    expect(stub!.actor).toBe('agent:maintenance');

    const afterScanResult = (await client.callTool({
      name: 'list_proposals',
      arguments: { status: 'pending' },
    })) as ContentResult;
    const afterScan = decode<EditProposal[]>(afterScanResult);
    expect(afterScan.map((p) => p.id)).toContain(stub!.id);
  });

  it('drives `tools/list` over the bundled `dist/server.js` when it exists', async () => {
    // Skip silently when the bundle hasn't been produced — `npm run build` is
    // its own gate. This second test catches bundle-config regressions (e.g. a
    // dep accidentally externalized) that the `tsx` path above can't see.
    const distEntry = path.join(mcpRoot, 'dist', 'server.js');
    try {
      await fs.access(distEntry);
    } catch {
      return;
    }

    let stderr = '';
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [distEntry],
      env: {
        ...process.env,
        CONTENT_ROOT: vault,
        API_BASE_URL: '',
      },
      stderr: 'pipe',
    });
    // Capture the readiness banner off the child's stderr. The SDK types the
    // getter as `Stream | null`; the underlying object is a Readable.
    const childStderr = transport.stderr as Readable | null;
    childStderr?.setEncoding('utf8');
    childStderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    client = new Client({ name: 'fresh-clone-bin-test', version: '0.0.0' });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.length).toBe(27);
    expect(tools.map((tool) => tool.name)).toContain('create_note');
    expect(tools.map((tool) => tool.name)).toContain('think');
    expect(tools.map((tool) => tool.name)).toContain('proposal_stats');
    expect(tools.map((tool) => tool.name)).toContain('schema_pack');

    // The readiness banner is what an MCP host log shows on a spawn — assert
    // both the prefix and the mode so a silent regression here is visible.
    expect(stderr).toMatch(/fsbrain-mcp ready/);
    expect(stderr).toMatch(/mode=embedded/);
  });
});
