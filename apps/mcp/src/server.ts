/**
 * MCP server exposing the markdown vault as agent tools.
 *
 * Designed to be launched by an MCP host (e.g. OpenClaw, Claude Desktop) as a
 * single command — so it bundles the storage API in-process by default and
 * only proxies an external API if you explicitly opt in via `API_BASE_URL`.
 *
 * Writes flow through that API and inherit its path validation, optimistic-
 * concurrency, and audit trail. Writes are attributed via the `X-Actor` header
 * (default `agent:mcp`, settable via `MCP_ACTOR`) so they appear in the
 * human-facing Activity feed.
 *
 * Run it standalone:
 *   npm --workspace @repo/mcp run start            # in-process API on 127.0.0.1
 *   API_BASE_URL=http://localhost:3001 npm --workspace @repo/mcp run start
 */
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer as createApiServer, loadConfig, type ServerConfig } from '@repo/api';
import { z } from 'zod';

import type {
  AnswerKit,
  ApiResponse,
  AuditEntry,
  Backlink,
  BlockAnchor,
  CategoryStat,
  ContextBundle,
  EditProposal,
  FeedbackFinding,
  FileNode,
  GraphData,
  HybridHit,
  KnowledgeGap,
  MaintenanceFinding,
  PageType,
  QuestionEntry,
  SearchMatch,
  SemanticHit,
  SkillCuratorFinding,
  SkillSummary,
  ThresholdRecommendation,
} from '@repo/shared';

// Empty string also counts as "not set" — that's what the fresh-clone e2e test
// uses to force embedded mode while inheriting the rest of the parent env.
const EXPLICIT_API_BASE_URL = process.env.API_BASE_URL?.replace(/\/$/, '') || undefined;
const ACTOR = process.env.MCP_ACTOR ?? 'agent:mcp';

class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface AppContext {
  apiBaseUrl: string;
  /** Resolved vault path; `undefined` when proxying an external API. */
  contentRoot?: string;
  /** Set when this process started the API itself; `undefined` if attached to an external API. */
  embeddedServer?: http.Server;
}

function createApiClient(context: AppContext) {
  return async function apiRequest<T>(
    pathname: string,
    init?: RequestInit & { actor?: boolean },
  ): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (init?.actor) {
      headers['X-Actor'] = ACTOR;
    }

    const response = await fetch(`${context.apiBaseUrl}${pathname}`, { ...init, headers });
    const payload = (await response.json()) as ApiResponse<T>;

    if (!response.ok || !payload.success) {
      const error = payload.success
        ? { code: 'unknown_error', message: `Request failed (${response.status})` }
        : payload.error;
      throw new ApiError(error.message, error.code);
    }

    return payload.data;
  };
}

function flattenFiles(nodes: FileNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.isDirectory) {
      paths.push(...flattenFiles(node.children ?? []));
    } else {
      paths.push(node.path);
    }
  }
  return paths;
}

/** Wrap a handler so API errors become readable tool errors instead of crashes. */
function tool<Args>(handler: (args: Args) => Promise<unknown>) {
  return async (args: Args) => {
    try {
      const result = await handler(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { isError: true, content: [{ type: 'text' as const, text: `Error: ${message}` }] };
    }
  };
}

/**
 * Start an in-process copy of the storage API on 127.0.0.1, ephemeral port (or
 * `PORT`). Returns the base URL the MCP tools should hit, the chosen
 * `ServerConfig`, and the underlying `http.Server` so we can close it on shutdown.
 */
async function startEmbeddedApi(): Promise<{
  baseUrl: string;
  server: http.Server;
  config: ServerConfig;
}> {
  // `createServer` only builds the http.Server; this function owns `listen`
  // because we need a loopback bind + ephemeral port (or `PORT`) regardless of
  // what `loadConfig` saw in env. The config we return reflects the resolved
  // values (CONTENT_ROOT, host, port) so callers — including the welcome-seed
  // step and the readiness banner — see the real numbers.
  const baseConfig = loadConfig();
  const port = Number(process.env.PORT ?? 0);
  const server = createApiServer(baseConfig);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Embedded API failed to bind a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    config: { ...baseConfig, host: '127.0.0.1', port: address.port },
  };
}

/** Drop a friendly note in the vault on its very first launch so it isn't empty. */
async function maybeSeedWelcome(contentRoot: string): Promise<void> {
  try {
    const entries = await fs.readdir(contentRoot);
    const visible = entries.filter((name) => !name.startsWith('.'));
    if (visible.length > 0) {
      return;
    }
  } catch {
    return;
  }

  const welcomePath = path.join(contentRoot, 'welcome.md');
  const body = [
    '# Welcome to fsbrain',
    '',
    'This vault is a folder of plain markdown files that humans edit and agents',
    'can read, search, link, and write through an MCP server. Every agent write is',
    'recorded in the audit log (`.fsbrain/audit.jsonl`) so you can see what changed.',
    '',
    'Start by editing this note, or create new ones — the agent can find them with',
    '`search_notes` / `semantic_search`.',
    '',
  ].join('\n');

  try {
    await fs.writeFile(welcomePath, body, { encoding: 'utf8', flag: 'wx' });
  } catch {
    // Already exists, or unwritable — either way we won't fight the user.
  }
}

function registerTools(server: McpServer, apiRequest: ReturnType<typeof createApiClient>): number {
  let count = 0;
  const register = ((...args: Parameters<typeof server.tool>) => {
    count += 1;
    return server.tool(...args);
  }) as typeof server.tool;

  register(
    'list_notes',
    'List all markdown note paths in the vault (optionally under a subtree).',
    { path: z.string().optional().describe('Subtree path; omit for the whole vault.') },
    tool(async ({ path: subtree }: { path?: string }) => {
      const query = subtree ? `?path=${encodeURIComponent(subtree)}` : '';
      const tree = await apiRequest<FileNode[]>(`/api/tree${query}`);
      return { paths: flattenFiles(tree) };
    }),
  );

  register(
    'read_note',
    'Read the markdown content of a note by its logical path or its stable id.',
    {
      path: z.string().optional().describe('Logical path, e.g. "notes/idea.md".'),
      id: z.string().optional().describe('Stable note id from frontmatter `id:`.'),
    },
    tool(async ({ path: notePath, id }: { path?: string; id?: string }) => {
      if (!notePath && !id) {
        throw new Error('Either path or id is required');
      }
      const params = new URLSearchParams();
      if (notePath) params.set('path', notePath);
      else if (id) params.set('id', id);
      return apiRequest(`/api/file?${params.toString()}`);
    }),
  );

  register(
    'read_block',
    'Read a single block (paragraph / list-item / heading section) carrying a ' +
      '`^block-id` anchor, plus a short surrounding context. Address the note by ' +
      'path or by stable id.',
    {
      path: z.string().optional().describe('Logical path, e.g. "notes/idea.md".'),
      id: z.string().optional().describe('Stable note id (frontmatter `id:`).'),
      block: z.string().describe('Anchor id without the leading `^`, e.g. "claim-1".'),
    },
    tool(async ({ path: notePath, id, block }: { path?: string; id?: string; block: string }) => {
      if (!notePath && !id) {
        throw new Error('Either path or id is required');
      }
      const params = new URLSearchParams();
      if (notePath) params.set('path', notePath);
      else if (id) params.set('id', id);
      params.set('block', block);
      return apiRequest(`/api/block?${params.toString()}`);
    }),
  );

  register(
    'get_block_anchors',
    'List every `^block-id` anchor in a note. Useful before patching by block.',
    {
      path: z.string().optional().describe('Logical path, e.g. "notes/idea.md".'),
      id: z.string().optional().describe('Stable note id (frontmatter `id:`).'),
    },
    tool(async ({ path: notePath, id }: { path?: string; id?: string }) => {
      if (!notePath && !id) {
        throw new Error('Either path or id is required');
      }
      const params = new URLSearchParams();
      if (notePath) params.set('path', notePath);
      else if (id) params.set('id', id);
      return apiRequest<{ path: string; anchors: BlockAnchor[] }>(
        `/api/block-anchors?${params.toString()}`,
      );
    }),
  );

  register(
    'create_note',
    'Create a new markdown note. Fails if it already exists.',
    {
      path: z.string().describe('Logical path ending in .md.'),
      content: z.string().default('').describe('Initial markdown content.'),
    },
    tool(async ({ path: notePath, content }: { path: string; content: string }) => {
      return apiRequest('/api/file', {
        method: 'POST',
        body: JSON.stringify({ path: notePath, content }),
        actor: true,
      });
    }),
  );

  register(
    'update_note',
    'Overwrite an existing note. Pass the current etag for safe optimistic-concurrency writes.',
    {
      path: z.string(),
      content: z.string(),
      etag: z.string().optional().describe('Etag from read_note; rejects the write if stale.'),
    },
    tool(
      async ({
        path: notePath,
        content,
        etag,
      }: {
        path: string;
        content: string;
        etag?: string;
      }) => {
        return apiRequest('/api/file', {
          method: 'PUT',
          body: JSON.stringify({ path: notePath, content, etag }),
          actor: true,
        });
      },
    ),
  );

  register(
    'search_notes',
    'Full-text and/or tag search across the vault. Provide query, tag, or both.',
    {
      query: z.string().optional().describe('Case-insensitive text to search note bodies for.'),
      tag: z.string().optional().describe('Tag name (without #) to filter by.'),
      limit: z.number().optional(),
    },
    tool(async ({ query, tag, limit }: { query?: string; tag?: string; limit?: number }) => {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (tag) params.set('tag', tag);
      if (limit) params.set('limit', String(limit));
      return apiRequest<SearchMatch[]>(`/api/search?${params.toString()}`);
    }),
  );

  register(
    'semantic_search',
    'Relevance-ranked retrieval: find the note passages most "about" a query, ' +
      'even without exact keyword matches. Best for RAG-style context gathering.',
    {
      query: z.string().describe('A natural-language description of what to find.'),
      limit: z.number().optional(),
    },
    tool(async ({ query, limit }: { query: string; limit?: number }) => {
      const params = new URLSearchParams({ q: query });
      if (limit) params.set('limit', String(limit));
      return apiRequest<SemanticHit[]>(`/api/semantic-search?${params.toString()}`);
    }),
  );

  register(
    'hybrid_search',
    'Hybrid retrieval: fuses full-text (keyword) and semantic (relevance) ' +
      'ranking via Reciprocal Rank Fusion. Prefer this as the default search — ' +
      'it surfaces exact keyword hits and conceptually-related passages in one ' +
      'ranked list, so you miss neither. Returns HybridHit[] (path, name, score, ' +
      'snippet, heading?, line, tags, sources: ("text" | "semantic")[]).',
    {
      query: z.string().describe('What to find — keywords or a natural-language description.'),
      limit: z.number().optional(),
    },
    tool(async ({ query, limit }: { query: string; limit?: number }) => {
      const params = new URLSearchParams({ q: query });
      if (limit) params.set('limit', String(limit));
      return apiRequest<HybridHit[]>(`/api/hybrid-search?${params.toString()}`);
    }),
  );

  register(
    'get_context',
    'Assemble a token-budgeted RAG context bundle for a query: the most ' +
      'relevant note passages, plus — when `focusPath` is given — that note and ' +
      'its backlinks as neighbor context. The primary tool to call before ' +
      'answering or editing so you ground on the vault. Returns a ContextBundle ' +
      '(items have path, heading?, text, score, kind: "match" | "neighbor").',
    {
      query: z.string().describe('A natural-language description of what you need context about.'),
      focusPath: z
        .string()
        .optional()
        .describe('A note to center the bundle on; adds it and its backlinks as neighbor context.'),
      budget: z
        .number()
        .optional()
        .describe('Approximate token budget for the bundle (default ~2000).'),
    },
    tool(
      async ({
        query,
        focusPath,
        budget,
      }: {
        query: string;
        focusPath?: string;
        budget?: number;
      }) => {
        const params = new URLSearchParams({ q: query });
        if (focusPath) params.set('path', focusPath);
        if (budget) params.set('budget', String(budget));
        return apiRequest<ContextBundle>(`/api/context?${params.toString()}`);
      },
    ),
  );

  register(
    'think',
    'Answer a question *grounded in the vault*. Runs hybrid retrieval, assembles ' +
      'a token-budgeted context bundle, and returns an AnswerKit: numbered ' +
      'citations ([1], [2]…) mapped to source passages (path, heading?, block?), ' +
      'the passages themselves, an offline gap analysis (`gaps.weakCoverage` + ' +
      '`gaps.uncoveredTerms` — "what the vault does not yet cover"), and a ' +
      'coverage summary. Call this before answering, then compose the final cited ' +
      'answer yourself from the returned citations — the synthesis is yours to do.',
    {
      query: z.string().describe('The question to answer from the vault.'),
      focusPath: z
        .string()
        .optional()
        .describe('A note to center the answer on; adds it and its backlinks as neighbor context.'),
      budget: z
        .number()
        .optional()
        .describe('Approximate token budget for the gathered passages (default ~2000).'),
    },
    tool(
      async ({
        query,
        focusPath,
        budget,
      }: {
        query: string;
        focusPath?: string;
        budget?: number;
      }) => {
        const params = new URLSearchParams({ q: query });
        if (focusPath) params.set('path', focusPath);
        if (budget) params.set('budget', String(budget));
        // `actor` so the question log attributes the query to this agent.
        return apiRequest<AnswerKit>(`/api/think?${params.toString()}`, { actor: true });
      },
    ),
  );

  register(
    'get_backlinks',
    'List notes that link to the given note via [[wikilinks]].',
    { path: z.string() },
    tool(async ({ path: notePath }: { path: string }) => {
      return apiRequest<Backlink[]>(`/api/backlinks?path=${encodeURIComponent(notePath)}`);
    }),
  );

  register(
    'get_graph',
    'Fetch the whole vault wikilink graph for traversal: `nodes` (id = note ' +
      "path, label, tags, optional canonical `type` = the note's frontmatter " +
      'page type, unresolved? for missing link targets) and `edges` (source, ' +
      'target, optional typed `type`). Edges come from body `[[wikilinks]]` and ' +
      'self-wire from frontmatter: any field whose value holds a `[[link]]` ' +
      '(e.g. `related: [[Foo]]`) becomes a typed edge with the field name as ' +
      '`type`. Use it to walk how notes connect. See `schema_pack` for the ' +
      'canonical node types.',
    {},
    tool(async () => {
      return apiRequest<GraphData>('/api/graph');
    }),
  );

  register(
    'schema_pack',
    "Fetch the vault's **schema pack**: the canonical note `type:` values " +
      '(person, meeting, project, idea…), each with a colour and the typed ' +
      'frontmatter relations it may declare (e.g. a `meeting` allows ' +
      '`attendees: [[Person]]`, `about: [[Topic]]`). Consult it before authoring ' +
      'or editing a note so you pick a canonical `type:` and only wire relations ' +
      'that type permits — the dream-cycle maintenance scan reports notes that ' +
      'declare an unknown type or a disallowed/mis-targeted relation as `schema` ' +
      'findings for human review. Returns { pageTypes }.',
    {},
    tool(async () => {
      return apiRequest<{ pageTypes: PageType[] }>('/api/schema');
    }),
  );

  register(
    'recent_activity',
    'Read the provenance/audit trail of recent vault changes (who changed what).',
    {
      path: z.string().optional().describe('Filter to a single note path.'),
      limit: z.number().optional(),
    },
    tool(async ({ path: notePath, limit }: { path?: string; limit?: number }) => {
      const params = new URLSearchParams();
      if (notePath) params.set('path', notePath);
      if (limit) params.set('limit', String(limit));
      const query = params.toString();
      return apiRequest<AuditEntry[]>(`/api/audit${query ? `?${query}` : ''}`);
    }),
  );

  register(
    'recent_questions',
    'Read the **question log**: recent `think` questions with their offline gap ' +
      'signal, plus the recurring **knowledge gaps** distilled from the whole ' +
      'log — terms that keep going uncovered across questions. A recurring gap ' +
      'means the vault keeps being asked something it cannot answer: if you ' +
      'know the missing material, `propose_edit` a note that fills the gap (or ' +
      'ask the human for it) — that is how usage grows the vault.',
    {
      limit: z.number().optional().describe('Max recent entries to return (default 50).'),
      minCount: z
        .number()
        .optional()
        .describe('Questions that must share an uncovered term to count as a gap (default 2).'),
    },
    tool(async ({ limit, minCount }: { limit?: number; minCount?: number }) => {
      const params = new URLSearchParams();
      if (limit) params.set('limit', String(limit));
      if (minCount) params.set('minCount', String(minCount));
      const query = params.toString();
      return apiRequest<{ entries: QuestionEntry[]; gaps: KnowledgeGap[] }>(
        `/api/questions${query ? `?${query}` : ''}`,
      );
    }),
  );

  register(
    'create_folder',
    'Create a folder in the vault.',
    { path: z.string() },
    tool(async ({ path: folderPath }: { path: string }) => {
      return apiRequest('/api/dir', {
        method: 'POST',
        body: JSON.stringify({ path: folderPath }),
        actor: true,
      });
    }),
  );

  register(
    'move_path',
    'Move or rename a note or folder.',
    { fromPath: z.string(), toPath: z.string() },
    tool(async ({ fromPath, toPath }: { fromPath: string; toPath: string }) => {
      return apiRequest('/api/path', {
        method: 'PATCH',
        body: JSON.stringify({ fromPath, toPath }),
        actor: true,
      });
    }),
  );

  register(
    'delete_path',
    'Delete a note or folder. Set recursive to remove a non-empty folder.',
    { path: z.string(), recursive: z.boolean().optional() },
    tool(async ({ path: targetPath, recursive }: { path: string; recursive?: boolean }) => {
      const params = new URLSearchParams({
        path: targetPath,
        recursive: String(Boolean(recursive)),
      });
      return apiRequest(`/api/path?${params.toString()}`, { method: 'DELETE', actor: true });
    }),
  );

  register(
    'patch_note',
    'Granular edits to a note: append text, prepend text (after frontmatter), ' +
      'replace the body under a heading, replace the block carrying a ' +
      '`^block-id` anchor, or ensure the note has a stable `id:` in frontmatter. ' +
      'Address the note by `path` or by stable `id`. Pass `etag` (from read_note) ' +
      'for safe optimistic-concurrency writes, an `idempotencyKey` to make a ' +
      'retry a no-op, or `dryRun: true` to preview the result without writing.',
    {
      path: z.string().optional(),
      id: z.string().optional().describe('Stable note id (frontmatter `id:`).'),
      op: z.discriminatedUnion('type', [
        z
          .object({ type: z.literal('append'), text: z.string() })
          .describe('Append `text` to the end of the note.'),
        z
          .object({ type: z.literal('prepend'), text: z.string() })
          .describe('Insert `text` at the top; lands after frontmatter if present.'),
        z
          .object({
            type: z.literal('replace_section'),
            heading: z.string().describe('The full heading line, e.g. "## Tasks".'),
            body: z.string().describe('New body to insert under the heading.'),
          })
          .describe('Replace the body under a heading; siblings are kept.'),
        z
          .object({
            type: z.literal('replace_block'),
            blockId: z.string().describe('Anchor id without the leading `^`.'),
            body: z.string().describe('New body to substitute for the block.'),
          })
          .describe('Replace the paragraph/list-item/heading-section carrying `^blockId`.'),
        z
          .object({
            type: z.literal('ensure_id'),
            id: z
              .string()
              .optional()
              .describe('Specific id to assign; a UUID is generated when omitted.'),
          })
          .describe('Add an `id:` to frontmatter if missing (idempotent).'),
      ]),
      etag: z.string().optional().describe('Etag from read_note; rejects the patch if stale.'),
      idempotencyKey: z
        .string()
        .optional()
        .describe('Replay protection — the same key returns the original result without writing.'),
      dryRun: z.boolean().optional().describe('Compute the result without writing.'),
    },
    tool(
      async (args: {
        path?: string;
        id?: string;
        op:
          | { type: 'append'; text: string }
          | { type: 'prepend'; text: string }
          | { type: 'replace_section'; heading: string; body: string }
          | { type: 'replace_block'; blockId: string; body: string }
          | { type: 'ensure_id'; id?: string };
        etag?: string;
        idempotencyKey?: string;
        dryRun?: boolean;
      }) => {
        if (!args.path && !args.id) {
          throw new Error('Either path or id is required');
        }
        return apiRequest('/api/file', {
          method: 'PATCH',
          body: JSON.stringify(args),
          actor: true,
        });
      },
    ),
  );

  register(
    'propose_edit',
    'Propose a create/update/delete for human review instead of writing directly. ' +
      'Use this when changes should be approved by the human before they land.',
    {
      action: z.enum(['create', 'update', 'delete']),
      path: z.string(),
      content: z.string().optional().describe('Required for create/update.'),
      baseEtag: z
        .string()
        .optional()
        .describe('Etag from read_note, so a stale update is rejected on approval.'),
      note: z.string().optional().describe('Why you are proposing this change.'),
    },
    tool(
      async (args: {
        action: 'create' | 'update' | 'delete';
        path: string;
        content?: string;
        baseEtag?: string;
        note?: string;
      }) =>
        apiRequest('/api/proposals', {
          method: 'POST',
          body: JSON.stringify(args),
          actor: true,
        }),
    ),
  );

  register(
    'list_proposals',
    'List edit proposals and their review status (pending/approved/rejected). ' +
      'Approval/rejection is a human action and is not available to agents.',
    { status: z.enum(['pending', 'approved', 'rejected']).optional() },
    tool(async ({ status }: { status?: 'pending' | 'approved' | 'rejected' }) => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      const query = params.toString();
      return apiRequest<EditProposal[]>(`/api/proposals${query ? `?${query}` : ''}`);
    }),
  );

  register(
    'proposal_stats',
    'Review-queue learning: per-category approve/reject tallies for the edit ' +
      'proposals the human has resolved, plus any bounded threshold nudges the ' +
      "scans derive from them. Use it to learn the human's taste before filing " +
      'a kind of proposal they routinely reject — categories like ' +
      '`maintenance:duplicate` or `feedback:x` with a low `approvalRate` mean ' +
      'back off or raise your bar; a high rate means keep going. Read-only: it ' +
      'files and resolves nothing. Returns { categories, recommendations }.',
    {},
    tool(async () =>
      apiRequest<{ categories: CategoryStat[]; recommendations: ThresholdRecommendation[] }>(
        '/api/proposals/stats',
      ),
    ),
  );

  register(
    'list_skills',
    "List the vault's **skill notes** — reusable procedural playbooks (notes " +
      'with frontmatter `type: skill`) describing how to perform a task: the ' +
      'goal, the steps, the gotchas. Check here before starting a non-trivial ' +
      'task and `read_note` a matching skill to follow it. After finishing a ' +
      'task where you learned a reusable procedure, distill it into a skill ' +
      'note via `propose_edit` (create or update a note whose frontmatter has ' +
      '`type: skill`, plus optional `name:` and `description:`) so the human ' +
      "can review and approve it — that is how the vault's skills grow.",
    {
      query: z
        .string()
        .optional()
        .describe('Case-insensitive filter over skill names, descriptions, paths, and tags.'),
    },
    tool(async ({ query }: { query?: string }) => {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      const search = params.toString();
      return apiRequest<SkillSummary[]>(`/api/skills${search ? `?${search}` : ''}`);
    }),
  );

  register(
    'curate_skills',
    "Curate the vault's skill library (report-only). Flags skill notes that are " +
      'structurally **incomplete** (missing canonical sections — When to Use / ' +
      'Procedure / Pitfalls / Verification), near-**duplicate** skills worth ' +
      'consolidating, and **stale** skills unchanged for a long time. Files ' +
      'nothing — to act on a finding, `propose_edit` the fleshed-out or merged ' +
      'skill for human review (that is how the skill library improves). A skill ' +
      'with frontmatter `pinned: true` is exempt from the duplicate/stale flags. ' +
      'Resolution stays human-only. Returns { findings }.',
    {},
    tool(async () => apiRequest<{ findings: SkillCuratorFinding[] }>('/api/skills/curator')),
  );

  register(
    'run_maintenance',
    'Run the dream-cycle vault maintenance scan: detect near-duplicate notes, ' +
      'broken [[wikilinks]], orphan notes, and stale-but-load-bearing notes ' +
      '(heavily linked but unchanged for a long time — flagged for an ' +
      '"is this still accurate?" review), and file each actionable finding ' +
      'as an edit proposal for human review (actor `agent:maintenance`). ' +
      'Idempotent — re-running will not re-file an already-open proposal, so it ' +
      'is safe to call repeatedly. Resolution stays human-only in the Review ' +
      'tab; this tool never applies an edit. Returns { findings, proposalsFiled }.',
    {},
    tool(async () =>
      apiRequest<{ findings: MaintenanceFinding[]; proposalsFiled: EditProposal[] }>(
        '/api/maintenance/scan',
        { method: 'POST' },
      ),
    ),
  );

  register(
    'run_feedback',
    'Run the outreach feedback loop: compare reviewed draft→final pairs (notes ' +
      'with frontmatter `type: feedback` linking a `draftPath`, a `finalPath`, ' +
      'and a `channel` of x|linkedin|email) and file each distilled lesson as an ' +
      'edit proposal that grows a channel playbook, for human review (actor ' +
      '`agent:feedback-loop`). The lesson is a deterministic diff summary (what ' +
      'the human removed/added, how much shorter it got, and any recorded ' +
      'reason) — never a posted or sent message. Idempotent: re-running will not ' +
      're-file an open proposal nor a lesson already approved into the playbook, ' +
      'so it is safe to call repeatedly. Resolution stays human-only in the ' +
      'Review tab. Returns { findings, proposalsFiled }.',
    {},
    tool(async () =>
      apiRequest<{ findings: FeedbackFinding[]; proposalsFiled: EditProposal[] }>(
        '/api/feedback/scan',
        { method: 'POST' },
      ),
    ),
  );

  return count;
}

/** Build the MCP server + tool surface against the chosen API base URL. */
export function buildServer(context: AppContext): { server: McpServer; toolCount: number } {
  const apiRequest = createApiClient(context);
  const server = new McpServer({ name: 'fsbrain-vault', version: '0.1.0' });
  const toolCount = registerTools(server, apiRequest);
  return { server, toolCount };
}

/**
 * Bootstrap the runtime: start an in-process API if no external one was given,
 * seed a welcome note in an empty vault, then return the wired-up MCP server.
 * Exported so tests can drive it without spawning the bin.
 */
export async function bootstrap(): Promise<{
  server: McpServer;
  context: AppContext;
  toolCount: number;
}> {
  let context: AppContext;
  if (EXPLICIT_API_BASE_URL) {
    context = { apiBaseUrl: EXPLICIT_API_BASE_URL };
  } else {
    const { baseUrl, server, config } = await startEmbeddedApi();
    context = { apiBaseUrl: baseUrl, contentRoot: config.contentRoot, embeddedServer: server };
    await maybeSeedWelcome(config.contentRoot);
  }
  const { server, toolCount } = buildServer(context);
  return { server, context, toolCount };
}

function installShutdownHandlers(context: AppContext): void {
  const close = async () => {
    if (context.embeddedServer) {
      await new Promise<void>((resolve) => context.embeddedServer?.close(() => resolve()));
    }
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

async function main() {
  const { server, context, toolCount } = await bootstrap();
  installShutdownHandlers(context);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const mode = context.embeddedServer ? 'embedded' : 'proxied';
  const vault = context.contentRoot ?? '(external API)';
  // Stdio reserves stdout for MCP frames; status goes to stderr.
  // eslint-disable-next-line no-console
  console.error(
    `fsbrain-mcp ready · mode=${mode} · vault=${vault} · tools=${toolCount} · actor=${ACTOR}`,
  );
}

// Run as an entry point (CLI / bin / `tsx src/server.ts`) but stay quiet when
// imported as a library (e.g. from tests that drive `bootstrap()` themselves).
const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const selfPath = fileURLToPath(import.meta.url);
if (entryPath && entryPath === selfPath) {
  main().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('fsbrain MCP server failed to start:', error);
    process.exit(1);
  });
}
