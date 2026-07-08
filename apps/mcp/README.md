# @repo/mcp — Vault MCP server

An [MCP](https://modelcontextprotocol.io) server that exposes the markdown vault
as tools an AI agent can call. It is a **single-command launcher**: the storage
API (`apps/api`) runs in-process on `127.0.0.1` by default, so an MCP host
(OpenClaw, Claude Desktop, Claude Code, Cursor) only needs to spawn one stdio
process.

Agent writes are attributed via the `X-Actor` header (default `agent:mcp`,
override via `MCP_ACTOR`), so they appear in the human-facing **Activity**
feed and the audit log at `<CONTENT_ROOT>/.fsbrain/audit.jsonl`.

## Tools

| Tool                | Description                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `list_notes`        | List all note paths (optionally under a subtree).                                        |
| `read_note`         | Read a note by path or stable id (returns content + etag + `id`).                        |
| `read_block`        | Read a single `^block-id` block + surrounding context.                                   |
| `get_block_anchors` | List every `^block-id` anchor in a note.                                                 |
| `create_note`       | Create a new note.                                                                       |
| `update_note`       | Overwrite a note (pass `etag` for safe writes).                                          |
| `patch_note`        | append/prepend/replace_section/replace_block/ensure_id, etag + dry-run.                  |
| `search_notes`      | Full-text and/or tag search.                                                             |
| `semantic_search`   | Relevance-ranked retrieval (TF-IDF) for RAG.                                             |
| `hybrid_search`     | Fuses keyword + semantic ranking via Reciprocal Rank Fusion.                             |
| `get_context`       | Token-budgeted RAG context bundle (matches + focus-note neighbors).                      |
| `think`             | Cited answer kit (citations + passages) + offline gap analysis.                          |
| `get_backlinks`     | Notes linking to a note via `[[wikilinks]]` (includes `rel:` type).                      |
| `get_graph`         | Whole vault graph (`nodes`/`edges`); edges self-wire from `related:`-style frontmatter.  |
| `schema_pack`       | Canonical note `type:`s (person, meeting…) with colours + allowed frontmatter relations. |
| `recent_activity`   | Read the provenance/audit trail.                                                         |
| `recent_questions`  | Question log + recurring knowledge gaps (what the vault can't answer yet).               |
| `create_folder`     | Create a folder.                                                                         |
| `move_path`         | Move/rename a note or folder.                                                            |
| `delete_path`       | Delete a note or folder.                                                                 |
| `propose_edit`      | Propose a create/update/delete for human review.                                         |
| `list_proposals`    | List proposals + review status (resolve is human).                                       |
| `proposal_stats`    | Per-category approve/reject rates + threshold nudges (review-queue learning).            |
| `list_skills`       | List skill notes (`type: skill`) — reusable procedural playbooks.                        |
| `curate_skills`     | Report-only skill-library curator: incomplete / near-duplicate / stale skills.           |
| `run_maintenance`   | Dream-cycle scan: broken-link/orphan/duplicate fixes + stale-note & schema flags.        |
| `run_feedback`      | Learn from reviewed draft→final outreach pairs; file lessons as proposals.               |

`update_note` and `move_path` reject stale writes via the API's optimistic
concurrency check. There is **no** `resolve` tool: edit-proposal resolution is
human-only by design.

**Skill notes (procedural memory).** A note whose frontmatter declares
`type: skill` (plus optional `name:` / `description:`) is a reusable playbook —
goal, steps, gotchas. `list_skills` finds them; read one with `read_note`.
After completing a task that taught you a reusable procedure, contribute it
back with `propose_edit` (a `type: skill` note) so the human approves it — the
skill library grows from real work, with review. `curate_skills` is a
report-only pass over that library: it flags skills that are structurally
**incomplete** (missing canonical sections), near-**duplicate**, or **stale**
(long unchanged), so you can `propose_edit` a fleshed-out or consolidated skill.
A skill with frontmatter `pinned: true` is exempt from the duplicate/stale
flags. It files nothing — resolution stays human-only.

**Schema packs (typed page types).** `schema_pack` returns the canonical note
`type:` values (person, meeting, project, idea…), each with a colour and the
typed **frontmatter** relations it may declare (e.g. a `meeting` allows
`attendees: [[Person]]`, `about: [[Topic]]`). Consult it before creating or
editing a note so you pick a canonical `type:` and only wire relations that type
permits — `run_maintenance` reports a note that declares an unknown type or a
disallowed/mis-targeted relation as a report-only `schema` finding for human
review.

Build once, then launch:

```bash
npm install
npm run build              # produces apps/mcp/dist/server.js
npm run start:agent        # from the repo root — runs `fsbrain-mcp` on stdio
```

The server prints a one-line readiness banner on stderr:

```
fsbrain-mcp ready · mode=embedded · vault=/home/me/.fsbrain/vault · tools=27 · actor=agent:mcp
```

For active development with auto-reload:

```bash
npm --workspace @repo/mcp run dev
```

Or attach to an externally-running API:

```bash
API_BASE_URL=http://localhost:3001 npm --workspace @repo/mcp run start
```

After building, the bin is reachable as `fsbrain-mcp` (npm `bin`) or directly
as `node apps/mcp/dist/server.js`.

## Configuration

| Env var        | Default              | Purpose                                                          |
| -------------- | -------------------- | ---------------------------------------------------------------- |
| `CONTENT_ROOT` | `~/.fsbrain/vault`   | Vault directory; auto-created on first run.                      |
| `MCP_ACTOR`    | `agent:mcp`          | Actor label recorded on writes.                                  |
| `API_BASE_URL` | _(unset)_            | When set, proxy this URL instead of starting the in-process API. |
| `PORT`         | _(ephemeral)_        | Port for the in-process API (use `0` or omit for any).           |
| `HOST`         | `127.0.0.1` in embed | Bind address for the in-process API.                             |

When the vault is empty on first launch in embedded mode, the server seeds a
`welcome.md` so an MCP host has something to list. (Running `npm run dev:api`
against an empty vault does **not** auto-seed — only the MCP launcher does.)

## Connect an MCP host

Copy-paste config snippets for OpenClaw / Claude Desktop / Claude Code / Cursor:
[`../../docs/CONNECT.md`](../../docs/CONNECT.md).

## Fresh-clone guarantee

`src/__tests__/freshClone.test.ts` spawns the server as a real stdio child
against a temp `CONTENT_ROOT` and drives it via the official MCP SDK client.
It asserts `tools/list` returns all 26 expected names, round-trips
`create_note` → `read_note` → `search_notes` → `semantic_search` →
`hybrid_search` → `think` → `propose_edit` → `list_proposals` → `recent_activity`
→ `run_maintenance`, and confirms the write landed both on disk and in
`.fsbrain/audit.jsonl`. A second test exercises
the bundled `dist/server.js` (skipped if `npm run build` hasn't been run).
Runs in `npm test`.
