# API

The API exposes filesystem-backed endpoints for GitHub-like tree browsing and Notion-style content editing.

## Endpoints

### `GET /health`

Simple service health check.

### `GET /api/tree?path=...`

Lists the directory tree recursively under the provided logical `path`.

- `path` is optional. Empty path (`""`) lists the content root.

Example:

```bash
curl "http://localhost:3001/api/tree?path=notes"
```

### `GET /api/file?path=...` (or `?id=...`)

Reads a markdown file.

- Address the note by `path` (logical path under `CONTENT_ROOT`) or by `id`
  (frontmatter `id:`, when present). Only `.md` files are supported.
- Path must resolve under `CONTENT_ROOT`.

Example:

```bash
curl "http://localhost:3001/api/file?path=notes/todo.md"
curl "http://localhost:3001/api/file?id=2f3a-stable"   # alternative
```

Response includes:

- `content`
- `lastModified`
- `etag` (for optimistic concurrency)
- `id` — the note's stable id from frontmatter, when one is present

### `PUT /api/file`

Updates an existing markdown file.

Request body schema:

```json
{
  "path": "notes/todo.md",
  "content": "# updated",
  "etag": "optional-current-etag",
  "lastModified": "optional-current-lastModified"
}
```

Optimistic concurrency:

- If `etag` is supplied and does not match current file `etag`, request fails with `409 stale_write`.
- If `lastModified` is supplied and does not match current file `lastModified`, request fails with `409 stale_write`.

Example:

```bash
curl -X PUT "http://localhost:3001/api/file" \
  -H "Content-Type: application/json" \
  -d '{"path":"notes/todo.md","content":"# Updated","etag":"abc123"}'
```

### `PATCH /api/file`

Applies a granular edit to an existing markdown file without rewriting the
whole note. Designed for agents that want to add a task, prepend a status
block, or rewrite one section.

Request body schema:

```json
{
  "path": "notes/todo.md",
  "op": { "type": "append", "text": "- buy milk" },
  "etag": "optional-current-etag",
  "lastModified": "optional-current-lastModified",
  "idempotencyKey": "optional-string",
  "dryRun": false
}
```

Address the note by `path` OR by `id` (frontmatter `id:`). Supported `op`
shapes:

- `{ "type": "append", "text": "..." }` — append `text` to the end of the note.
- `{ "type": "prepend", "text": "..." }` — insert `text` at the top, AFTER any
  YAML frontmatter block so metadata stays at the top of the note.
- `{ "type": "replace_section", "heading": "## Tasks", "body": "..." }` —
  replace the body under the first heading matching `heading` exactly, up to
  the next sibling-or-higher heading (or EOF). The heading line itself is
  preserved. Returns `404 not_found` when the heading is not present.
- `{ "type": "replace_block", "blockId": "claim-1", "body": "..." }` —
  replace the block (paragraph / list-item / heading section) carrying the
  `^block-id` anchor. The anchor is re-attached to the replacement so future
  reads can still address the block. Returns `404 not_found` when no anchor
  with that id exists.
- `{ "type": "ensure_id", "id": "optional-uuid" }` — ensure the note has a
  stable `id:` in its frontmatter. If `id` is omitted, a fresh UUID is
  generated. Idempotent: a second call returns the existing id without
  rewriting the file or recording a new audit entry.

Optimistic concurrency mirrors `PUT /api/file`: pass `etag` (or
`lastModified`) to refuse the patch if the file changed under you (`409
stale_write`).

Idempotency: pass `idempotencyKey` so a retried request (e.g. after a network
blip) is a no-op — the original response is replayed without writing again
or recording a second audit entry. Keys are held in memory and reset on API
restart.

Dry run: pass `"dryRun": true` to receive the resulting content without
writing the file or recording an audit entry. The response sets
`dryRun: true`; its `etag` / `lastModified` describe the current (unchanged)
file, while `content` is the would-be result.

Example:

```bash
curl -X PATCH "http://localhost:3001/api/file" \
  -H "Content-Type: application/json" \
  -H "X-Actor: agent:mcp" \
  -d '{"path":"notes/todo.md","op":{"type":"append","text":"- buy milk"}}'
```

### `POST /api/file`

Creates a new markdown file.

Request body schema:

```json
{
  "path": "notes/new-page.md",
  "content": "# New Page"
}
```

Example:

```bash
curl -X POST "http://localhost:3001/api/file" \
  -H "Content-Type: application/json" \
  -d '{"path":"notes/new-page.md","content":"# New Page"}'
```

### `POST /api/dir`

Creates a directory (recursive mkdir).

Request body schema:

```json
{
  "path": "notes/projects"
}
```

Example:

```bash
curl -X POST "http://localhost:3001/api/dir" \
  -H "Content-Type: application/json" \
  -d '{"path":"notes/projects"}'
```

### `PATCH /api/path`

Moves/renames a path.

Request body schema:

```json
{
  "fromPath": "notes/old.md",
  "toPath": "notes/archive/old.md"
}
```

Supports directories and markdown files.

Example:

```bash
curl -X PATCH "http://localhost:3001/api/path" \
  -H "Content-Type: application/json" \
  -d '{"fromPath":"notes/old.md","toPath":"notes/archive/old.md"}'
```

### `DELETE /api/path?path=...&recursive=...`

Deletes a markdown file or directory.

- `path` (required): file or directory path.
- `recursive` (optional): `true`/`1` to recursively delete non-empty directories.

Example:

```bash
curl -X DELETE "http://localhost:3001/api/path?path=notes/archive&recursive=true"
```

### `GET /api/backlinks?path=...`

Lists notes that link to `path` via `[[wikilinks]]`. Returns `Backlink[]`
(`{ path, name, type? }`). When the link carried a typed relation
(`[[Target|rel:supports]]`), the backlink includes `type: "supports"`.

### `GET /api/graph`

Returns the whole vault wikilink graph — `GraphData`
(`{ nodes, edges }`) — built from the same `[[wikilink]]` extraction +
resolution as `/api/backlinks`, served from the cached index (no per-call
vault re-read). `.fsbrain/` is excluded. Read-only (emits no `VaultEvent`).

- `nodes`: `{ id, label, tags, type?, unresolved? }`. A real note's `id` is its
  logical path; `label` is the basename without `.md`. `type` is the note's
  declared frontmatter `type:` (normalized to lowercase, e.g. `person`), present
  only for real notes that declare one — resolve it to a colour/label via the
  schema pack (`GET /api/schema`). An unresolved link target (a `[[wikilink]]`
  that resolves to no note) is included as a distinct placeholder node with
  `unresolved: true` and empty `tags`.
- `edges`: `{ source, target, type? }`. `source`/`target` are node ids;
  `type` carries the typed relation from `[[Target|rel:supports]]` when present.
  Self-links and duplicate edges are dropped. When a pair is connected by both a
  typed edge and a bare untyped body mention, the redundant untyped edge is
  collapsed away (a formal relation subsumes a prose mention); distinct typed
  edges between the same pair are all kept.
- **Self-wiring from frontmatter.** Any frontmatter field whose value contains a
  `[[wikilink]]` becomes a typed edge with the **field name as `type`** — so
  `related: [[Foo]]` yields `{ source, target: "Foo.md", type: "related" }` with
  no manual `[[Foo|rel:related]]` in the body. Presence of `[[...]]` is the
  signal, so plain scalars (`type: person`, `tags: [a, b]`) never wire an edge; a
  link carrying its own `rel:` type overrides the field name. Inline
  (`related: [[Foo]], [[Bar]]`) and YAML block-list forms are both recognised.

```json
{
  "nodes": [
    { "id": "claim.md", "label": "claim", "tags": ["thesis"] },
    { "id": "evidence.md", "label": "evidence", "tags": [] },
    { "id": "ghost", "label": "ghost", "tags": [], "unresolved": true }
  ],
  "edges": [
    { "source": "claim.md", "target": "evidence.md", "type": "supports" },
    { "source": "claim.md", "target": "ghost" }
  ]
}
```

### `GET /api/schema`

Returns the vault's **schema pack** — `{ pageTypes }` — the canonical note
`type:` values with their colours and allowed typed relations. Static (the
built-in `DEFAULT_SCHEMA_PACK`), so it takes no vault read and emits no
`VaultEvent`. Agents use it to author well-typed notes; the Graph view uses the
colours; the dream-cycle maintenance scan validates notes against it and reports
violations as report-only `schema` findings (it never auto-edits frontmatter).

- `pageTypes`: `{ type, label, color, description, relations }[]`. `type` is the
  canonical (lowercase) `type:` value; `relations` is `{ name, targetTypes?,
description? }[]` — the typed **frontmatter** relations a note of that type may
  declare, with an optional allowed target-type constraint. Every type allows the
  universal `related` association.

```json
{
  "pageTypes": [
    {
      "type": "meeting",
      "label": "Meeting",
      "color": "#b58bc4",
      "description": "Notes from a meeting or call.",
      "relations": [
        { "name": "related" },
        { "name": "attendees", "targetTypes": ["person"] },
        { "name": "about", "targetTypes": ["topic", "project"] }
      ]
    }
  ]
}
```

### `GET /api/block?path=...&block=<id>` (or `?id=<note-id>&block=<id>`)

Reads a single block (paragraph / list-item / heading section) carrying the
`^block-id` anchor, plus a few lines of surrounding context. Address the note
by `path` or by stable `id`. Returns `404 not_found` when the anchor is not
present.

```json
{
  "path": "notes/idea.md",
  "blockId": "claim-1",
  "startLine": 5,
  "endLine": 5,
  "text": "A claim worth citing.",
  "context": "Intro paragraph.\nA claim worth citing.\nClosing note.",
  "etag": "abc123",
  "lastModified": "2026-06-02T..."
}
```

### `GET /api/block-anchors?path=...` (or `?id=<note-id>`)

Lists every `^block-id` anchor in a note (id, 1-based line, line text). Useful
for an agent to discover stable addresses before patching by block.

### `GET /api/search?q=...&tag=...&limit=...`

Full-text and/or tag search across note bodies. At least one of `q` or `tag`
is required. Returns `SearchMatch[]` (`{ path, name, score, snippet, line, tags }`)
sorted by score.

```bash
curl "http://localhost:3001/api/search?q=roadmap"
curl "http://localhost:3001/api/search?tag=project"
```

### `GET /api/skills?q=...`

List the vault's **skill notes** — procedural playbooks marked with frontmatter
`type: skill`. `name` comes from frontmatter `name:`, else the first heading,
else the filename; `description` from frontmatter `description:`, else the
first body paragraph line. Optional `q` filters by a case-insensitive substring
over name, description, path, and tags. Returns `SkillSummary[]`
(`{ path, name, description, tags }`) sorted by name. Reading a skill is a
plain `GET /api/file`; creating or updating one should go through the proposal
queue so a human signs off.

```bash
curl "http://localhost:3001/api/skills"
curl "http://localhost:3001/api/skills?q=release"
```

### `GET /api/semantic-search?q=...&limit=...`

Relevance-ranked retrieval. Chunks every note (frontmatter stripped) and ranks
the chunks against `q` by TF-IDF cosine similarity, so it surfaces passages
that are topically about the query rather than exact substring matches. `q` is
required. Returns `SemanticHit[]` (`{ path, heading?, snippet, score, chunkIndex }`)
sorted by score. Runs locally with no API key.

```bash
curl "http://localhost:3001/api/semantic-search?q=how%20do%20backups%20work"
```

Internally, both `/api/search` and `/api/semantic-search` read through an
in-memory cached index (chunks + IDF computed once, reused across queries and
rebuilt when a note changes), so retrieval no longer re-reads the whole vault
per request. Ranking is identical to reading the vault fresh each time.

### `GET /api/hybrid-search?q=...&limit=...`

**Hybrid retrieval.** Runs both the lexical (`/api/search`) and semantic
(`/api/semantic-search`) engines and fuses their rankings by **Reciprocal Rank
Fusion** (`hybrid.ts`), so a note found by either — or modestly by both — ranks
well without normalizing the engines' non-comparable scores. `q` is required.
Returns `HybridHit[]` (`{ path, name, score, snippet, heading?, line, tags,
sources }`, where `sources` is a subset of `["text","semantic"]`) sorted by the
fused score; the exact lexical line is preferred as the display snippet. Reads
through the same cached index, and runs locally with no API key.

```bash
curl "http://localhost:3001/api/hybrid-search?q=backup%20restore%20procedure"
```

### `GET /api/context?q=...&path=...&budget=...`

Assembles a token-budgeted **context bundle** — the passages an agent should
read before answering or editing — ready to feed an LLM. Stays local: it ranks
with the same offline TF-IDF engine, no embedding provider or network.

- `q` (required): the query to retrieve passages for.
- `path` (optional): a focus note. When given, the bundle also includes that
  note's chunks and its backlinks (a short excerpt each) as **neighbor**
  context.
- `budget` (optional): approximate token budget (default `2000`). Tokens are
  approximated as `ceil(chars / 4)` — no tokenizer dependency.

Assembly: take the top query-ranked chunks (`kind: "match"`), then — if `path`
is given — the focus note + backlink neighbors (`kind: "neighbor"`); de-dupe by
path+heading+text, pack in priority order, and stop when the budget is hit.

Returns a `ContextBundle` (from `@repo/shared`):

```json
{
  "query": "how do backups work",
  "focusPath": "ops/backups.md",
  "tokenBudget": 2000,
  "usedTokens": 184,
  "items": [
    {
      "path": "ops/backups.md",
      "heading": "Backup strategy",
      "text": "Snapshots run nightly…",
      "score": 0.42,
      "kind": "match"
    },
    {
      "path": "ops/runbook.md",
      "text": "See [[backups]] before a restore…",
      "score": 0,
      "kind": "neighbor"
    }
  ],
  "truncated": false
}
```

```bash
curl "http://localhost:3001/api/context?q=how%20do%20backups%20work&budget=1500"
curl "http://localhost:3001/api/context?q=restore&path=ops/backups.md"
```

The bundle-shaping (token estimation, de-dupe, budget packing) lives as pure,
tested helpers in `@repo/shared` (`context.ts`); the ranking engine is swappable
for real vector embeddings later behind the same `documents → ranked` contract.

### `GET /api/think?q=...&path=...&budget=...&synthesize=...`

The **brain layer**: turns a question into a grounded, cited **answer kit**
instead of raw pages. It runs hybrid retrieval (fuse lexical + semantic by RRF),
assembles a token-budgeted context bundle from the fused passages, and returns
numbered citations + an **offline gap analysis** via the pure `assembleAnswerKit`
(`@repo/shared` `think.ts`). `q` is required (`422` otherwise). Reads through the
cached index — no extra vault read.

- `q` (required): the question to answer.
- `path` (optional): a focus note. When given, the bundle also includes that
  note's chunks and its backlinks as **neighbor** context (also citable).
- `budget` (optional): approximate token budget for the gathered passages
  (default `2000`).
- `synthesize` (optional): `1`/`true` to also return a synthesized prose
  `answer`. **Stays fully offline by default** — the answer is only produced when
  an OpenRouter key is configured **server-side** (`OPENROUTER_API_KEY`; model via
  `OPENROUTER_MODEL`, default `anthropic/claude-3.5-sonnet`). With no key, this
  flag is ignored and the request never fails; the agent calling the MCP tool is
  itself the LLM and composes the final cited answer from the kit.

Returns an `AnswerKit` (from `@repo/shared`), optionally with `answer`:

```json
{
  "query": "how do backups work",
  "passages": [
    {
      "path": "ops/backups.md",
      "heading": "Strategy",
      "text": "Snapshots run nightly…",
      "score": 0.42,
      "kind": "match"
    }
  ],
  "citations": [
    {
      "n": 1,
      "path": "ops/backups.md",
      "heading": "Strategy",
      "block": "claim-1",
      "score": 0.42,
      "kind": "match",
      "excerpt": "Snapshots run nightly…"
    }
  ],
  "gaps": {
    "weakCoverage": false,
    "topScore": 0.42,
    "threshold": 0.1,
    "uncoveredTerms": ["offsite"]
  },
  "coverage": { "citations": 1, "notes": 1, "topScore": 0.42 }
}
```

Each `citations[].block` is the passage's block-anchor **id only** — the bare
`claim-1`, not the on-page `^claim-1` marker — so it can be passed straight to
`/api/block?block=`. It is present only when the passage carries an anchor.

The gap analysis is deterministic and computed with **no model**: `weakCoverage`
is true when the best match score is below `threshold` (or nothing matched), and
`uncoveredTerms` lists query terms (stem-compared) that no passage supports.

```bash
curl "http://localhost:3001/api/think?q=how%20do%20backups%20work"
curl "http://localhost:3001/api/think?q=restore&path=ops/backups.md&synthesize=1"
```

### `GET /api/audit?path=...&limit=...`

Returns the provenance/audit trail (`AuditEntry[]`, newest first), optionally
filtered to a single `path`.

### `GET /api/questions?limit=...&minCount=...`

The **question log**: every `/api/think` query is persisted with its offline
gap signal (`weakCoverage` + `uncoveredTerms`, attributed via `X-Actor`) to
`CONTENT_ROOT/.fsbrain/questions.jsonl`, beside the audit log. Returns
`{ entries, gaps }`: the most recent `QuestionEntry[]` (newest first, default
limit 50) and the recurring `KnowledgeGap[]` distilled from the **whole** log —
terms left uncovered by at least `minCount` questions (default 2), sorted by
frequency (`{ term, count, queries, lastTs }`). A recurring gap is a
demand-driven prompt for what note to write next. Logging is best-effort and
never fails the `think` call itself.

```bash
curl "http://localhost:3001/api/questions"
curl "http://localhost:3001/api/questions?limit=10&minCount=3"
```

### `GET /api/events`

A [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events)
stream (`Content-Type: text/event-stream`) of live vault changes, so a client
(the web UI) reflects what an agent — or another process — does the instant it
happens, without polling. Each change is sent as a single frame:

```
data: {"type":"created","path":"notes/idea.md","actor":"agent:mcp","ts":"2026-06-03T...","source":"api"}
```

The payload is a `VaultEvent` (from `@repo/shared`):

- `type` — `created` | `updated` | `moved` | `deleted` | `dir_created` |
  `proposal_created` | `proposal_resolved`.
- `path` — logical path affected (source path for moves).
- `toPath` — destination path, for `moved` events.
- `actor` — who caused it (`human`, `agent:mcp`, …); `external` for out-of-band
  edits picked up by the watcher.
- `ts` — ISO timestamp.
- `source` — `api` (published by a route handler alongside its audit write) or
  `watch` (published by the filesystem watcher for edits that never went through
  the API: a direct file edit, `git`, another process).

Implementation notes:

- Events come from an in-process `EventBus`. Every mutating handler publishes to
  it right where it records the audit entry, so the stream and the audit log
  never diverge.
- A filesystem watcher (`fs.watch`, recursive) covers out-of-band edits. It
  ignores the hidden `.fsbrain/` dir and non-`.md` churn, and de-dupes against
  API-originated writes so a single change does not double-fire.
- The stream sends periodic heartbeat comments to keep the connection alive and
  cleans up on client disconnect. The route is never buffered or compressed.
- No CORS headers are set, matching the rest of the API. The web client reaches
  it same-origin via the Vite dev proxy; a cross-origin deployment would need
  CORS (and, like the rest of the API, auth — out of scope for this local,
  single-user tool).

```bash
curl -N "http://localhost:3001/api/events"
```

### Edit proposals (review queue)

Lets agents suggest changes a human approves before they touch the vault.

- `POST /api/proposals` — create a proposal. Body: `{ action: "create"|"update"|"delete",
path, content?, baseEtag?, note?, category? }`. `content` is required for create/update;
  `baseEtag` (from a prior read) makes a stale `update` fail on approval; the optional
  `category` is a grouping key for review-queue stats (see below). The proposer is the
  `X-Actor` header. Returns the `EditProposal` (status `pending`).
- `GET /api/proposals?status=pending|approved|rejected` — list proposals (newest first).
- `GET /api/proposals/stats` — **review-queue learning**: returns
  `{ categories, recommendations }`. `categories` is the per-category approve/reject
  tally (`{ category, approved, rejected, pending, resolved, total, approvalRate }`,
  grouped by each proposal's `category` or, when absent, `actor:action`).
  `recommendations` are bounded threshold nudges derived from those rates (today: the
  dream-cycle duplicate-detection cosine, which `/api/maintenance/scan` adopts on its
  own once enough proposals are resolved). Read-only — it files and resolves nothing.
  Pure helper: `@repo/shared` `proposalStats.ts` (`summarizeOutcomes`,
  `recommendThreshold`).
- `POST /api/proposals/resolve` — body `{ id, decision: "approve"|"reject" }`. Approving
  applies the edit (recorded in the audit log as the **proposing** actor) and marks the
  proposal `approved`; rejecting discards it. Both destructive actions (`update`,
  `delete`) honor `baseEtag` and return `409 stale_write` if the file changed since the
  proposal was made. **Resolution is the human's action**; the resolver is taken from
  `X-Actor` (default `human`) and requests with an `agent:` actor are rejected `403`.
  This is convention-level (`X-Actor` is unauthenticated, so it is not airtight — the
  MCP server also omits a resolve tool); true enforcement needs authn/z. Proposals are
  stored under `CONTENT_ROOT/.fsbrain/proposals/`.

```bash
# Agent proposes an edit
curl -X POST "http://localhost:3001/api/proposals" \
  -H "Content-Type: application/json" -H "X-Actor: agent:mcp" \
  -d '{"action":"update","path":"notes/todo.md","content":"# Updated by agent","note":"tidy up"}'

# Human approves it
curl -X POST "http://localhost:3001/api/proposals/resolve" \
  -H "Content-Type: application/json" \
  -d '{"id":"<proposal-id>","decision":"approve"}'
```

### Maintenance (the "dream cycle")

A scan that finds vault-hygiene problems and files each actionable one as an
**edit proposal** a human approves in the Review tab — reusing the proposal queue
above. It runs fully offline (no model, no API key) over the cached `VaultIndex`
(no extra vault read). The detector is a pure, deterministic helper in
`@repo/shared` (`maintenance.ts`, `scanVault`). It detects:

- `broken_link` — a `[[wikilink]]` that resolves to no note. Suggestion: a
  `create` proposal for a stub of the missing target.
- `orphan` — a note with no inbound and no outbound **resolved** wikilinks
  (an isolated node). Report-only (no suggestion).
- `duplicate` — a pair of notes whose note-level TF-IDF cosine is ≥ a threshold.
  Suggestion (conservative): an `update` proposal appending a
  `> See also [[other]]` cross-link — never a merge.
- `stale` — a **load-bearing** note (≥ 3 inbound `[[wikilinks]]`, i.e. heavily
  cited) whose file mtime is older than 90 days: old + relied-upon is the
  highest-risk content, surfaced for an "is this still accurate?" review.
  Report-only (no suggestion). The server feeds `scanVault` a `now` reference
  and per-note mtimes (`modifiedAt`); a note with no readable mtime is never
  flagged. (Reads aren't logged, so inbound-citation count is the deterministic
  stand-in for "how often retrieved".)
- `schema` — a note that violates the **schema pack** (`GET /api/schema`): an
  unknown `type:`, a recognized **frontmatter** relation used on a type that
  doesn't allow it (an unknown field name is treated as the vault's own metadata
  and left alone), or a relation pointing at the wrong kind of note. Report-only
  (no suggestion) — the fix is a human editing frontmatter. The server passes
  `DEFAULT_SCHEMA_PACK` to `scanVault`; the validation itself is pure (`schema.ts`
  `validateVault`).

Each finding is `{ kind, paths, detail, score?, suggestion? }`, where
`suggestion` (when present) is a safe, reversible `{ action, path, content?,
note }` that maps 1:1 onto a proposal.

- `GET /api/maintenance` — a **dry preview**: returns `{ findings }`; files
  nothing.
- `POST /api/maintenance/scan` — files each finding's suggestion as a proposal
  (attributed to the `agent:maintenance` actor) and returns
  `{ findings, proposalsFiled, tuning? }`. **Self-tuning**: before scanning it
  reads the review queue's `maintenance:duplicate` approve/reject history (via
  `proposalStats.ts`) and nudges the duplicate-detection threshold — raising it
  when the human keeps rejecting cross-links (fewer, more confident matches),
  lowering it when they keep approving. Below the sample floor it uses the
  default; the applied nudge (if any) is echoed back as `tuning`. The human
  stays the gate — only the propensity to propose changes. **Idempotent**: a
  suggestion whose
  `action`+`path` already matches a still-relevant proposal — `pending` (awaiting
  review) or `rejected` (the human already declined it) — is skipped, so
  re-running never spams the Review queue and never re-surfaces a rejected fix. An
  `update` suggestion (the duplicate
  cross-link) is stamped with the target note's current `baseEtag`, so approving
  it after the note changed returns `409 stale_write` rather than overwriting the
  edit. Resolution stays human-only — the scan only proposes; it never applies an
  edit.

Scheduling is on-demand by default. Setting `MAINTENANCE_INTERVAL_MS` to a
positive number makes `createServer` also run the scan on that interval (the
timer is `unref`'d so it never keeps the process alive); leave it unset to
disable. Contradiction detection is intentionally out of scope for v1 (it needs
an LLM, which would break the offline guarantee).

```bash
curl "http://localhost:3001/api/maintenance"                  # preview, files nothing
curl -X POST "http://localhost:3001/api/maintenance/scan"     # scan + file proposals
```

### Outreach feedback loop (learn from human review)

Closes the "learn from human review" loop: when an agent drafts outreach (an X
post, a LinkedIn message, an email) and a human edits it before it ships, the
**diff between draft and final** is high-value procedural signal that today
evaporates. This scan captures it as a growing, human-audited playbook — reusing
the same proposal queue, fully offline. The detector is a pure, deterministic
helper in `@repo/shared` (`feedback.ts`, `scanFeedback`).

A **feedback pairing** is an ordinary note whose frontmatter declares
`type: feedback` plus a `channel` (`x` | `linkedin` | `email`), a `draftPath`,
and a `finalPath` (optionally a `targetPath` playbook and a free-text
`reviewReason`):

```yaml
---
type: feedback
channel: x
draftPath: social/x/drafts/launch.md
finalPath: social/x/old-posts/launch.md
targetPath: social/x/post-patterns.md # optional; default feedback/<channel>.md
reviewReason: Avoid claiming we make customers compliant; say audit evidence map.
---
```

For each pairing the scan distills a deterministic **lesson** — words trimmed,
phrases the human removed/added, and any `reviewReason` — and suggests growing
the target playbook. When the target does not exist yet it is proposed as a new
`type: skill` note at `feedback/<channel>.md`.

- `GET /api/feedback` — a **dry preview**: returns `{ findings }`; files nothing.
- `POST /api/feedback/scan` — files each lesson as a proposal (attributed to the
  `agent:feedback-loop` actor) and returns `{ findings, proposalsFiled }`.
  **Idempotent** on two levels: a suggestion whose `action`+`path` already matches
  a `pending`/`rejected` proposal is skipped, and each lesson carries a hidden
  marker so an already-approved lesson is never re-filed. An `update` is stamped
  with the target's `baseEtag` (`409 stale_write` on a stale approval). Resolution
  stays human-only, and **no draft is ever posted or sent** — the loop only
  proposes notes.

Scheduling is on-demand by default; setting `FEEDBACK_INTERVAL_MS` to a positive
number makes `createServer` also run the scan on that interval (the timer is
`unref`'d). The lesson is a mechanical diff summary, not an LLM-written rule — a
model-backed paraphrase would sit behind the same key gate `think`'s synthesis
uses.

```bash
curl "http://localhost:3001/api/feedback"                  # preview, files nothing
curl -X POST "http://localhost:3001/api/feedback/scan"     # scan + file proposals
```

## Provenance: the `X-Actor` header

Mutating requests (`POST`/`PUT`/`PATCH`/`DELETE`) may send an `X-Actor` header
identifying who is making the change (e.g. `human`, `agent:mcp`). It defaults to
`human`. Each successful mutation is appended to an append-only audit log at
`CONTENT_ROOT/.fsbrain/audit.jsonl` and surfaced via `GET /api/audit` and the
web **Activity** tab.

```bash
curl -X POST "http://localhost:3001/api/file" \
  -H "Content-Type: application/json" \
  -H "X-Actor: agent:mcp" \
  -d '{"path":"notes/from-agent.md","content":"# Written by an agent"}'
```

## Error model

All failures use this shape:

```json
{
  "success": false,
  "error": {
    "code": "validation_error",
    "message": "\"path\" must be a string"
  }
}
```

Standard error codes:

- `invalid_path`: path traversal/absolute path/not-allowed extension.
- `not_found`: missing file or directory.
- `validation_error`: invalid JSON schema/field type/empty value.
- `io_error`: unexpected filesystem errors.
- `conflict`: path already exists or destination conflicts.
- `stale_write`: optimistic concurrency check failed.
- `bad_request`: malformed request body or unsupported shape.
