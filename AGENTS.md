# AGENTS.md

> **Entry point for AI agents working in this repository.**
> Read this file first. It tells you where the knowledge lives and the rules
> you must follow while working here.

This project is a **local-first markdown workspace** (a GitHub-style file tree
over a filesystem-backed API) that is being grown into a **shared "brain"**:
plain markdown files that **humans edit and read**, and that **agents can also
read, search, link, and write** — with every change legible to the human.

If you are an agent operating this vault, you do not have to scrape the UI:
there is a first-class **MCP server** (`apps/mcp`) that exposes the vault as
tools, and every write you make is recorded with attribution so the human can
see it. See _What's built_ below.

---

## Where the knowledge lives (route yourself here)

Always orient yourself using these documents before acting:

| You want to know...                              | Read this                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| What exists, what's done, what's next            | [`docs/implementation.md`](docs/implementation.md)               |
| How to run, test, and validate the app           | [`docs/implementation.md`](docs/implementation.md) → _Commands_  |
| Manual integration checks                        | [`docs/integration-test-plan.md`](docs/integration-test-plan.md) |
| Backend API endpoints + request/response shapes  | [`apps/api/README.md`](apps/api/README.md)                       |
| Agent tools (MCP) + how writes are attributed    | [`apps/mcp/README.md`](apps/mcp/README.md)                       |
| Connect an MCP host (OpenClaw / Claude / Cursor) | [`docs/CONNECT.md`](docs/CONNECT.md)                             |
| Project overview / human-facing pitch            | [`README.md`](README.md)                                         |

`docs/implementation.md` is the **source of truth for project state**. When you
finish a unit of work, update it (see _Goal-driven execution_ below).

---

## Agent quick-reference (intent → MCP tool → HTTP endpoint)

The MCP server (`apps/mcp`) is your surface; each tool maps 1:1 to an endpoint on
the in-process API. Pick the tool that matches your intent:

| I want to…                                             | MCP tool            | HTTP endpoint                |
| ------------------------------------------------------ | ------------------- | ---------------------------- |
| List notes (optionally under a subtree)                | `list_notes`        | `GET /api/tree`              |
| Read a note (by `path` **or** `id`)                    | `read_note`         | `GET /api/file`              |
| Read one `^block` (+ surrounding context)              | `read_block`        | `GET /api/block`             |
| List a note's `^block` anchors                         | `get_block_anchors` | `GET /api/block-anchors`     |
| Create a note                                          | `create_note`       | `POST /api/file`             |
| Overwrite a note (pass `etag`)                         | `update_note`       | `PUT /api/file`              |
| Surgical edit (append/replace section/block, `dryRun`) | `patch_note`        | `PATCH /api/file`            |
| Full-text / `#tag` search                              | `search_notes`      | `GET /api/search`            |
| Semantic search (TF-IDF, or embeddings if enabled)     | `semantic_search`   | `GET /api/semantic-search`   |
| Hybrid (RRF) search                                    | `hybrid_search`     | `GET /api/hybrid-search`     |
| RAG context bundle (matches + focus-note neighbors)    | `get_context`       | `GET /api/context`           |
| Cited answer kit + offline gap analysis                | `think`             | `GET /api/think`             |
| Backlinks (incl. `rel:` type)                          | `get_backlinks`     | `GET /api/backlinks`         |
| Whole vault wikilink graph                             | `get_graph`         | `GET /api/graph`             |
| Schema pack (canonical `type:`s + relations)           | `schema_pack`       | `GET /api/schema`            |
| Recent provenance / audit trail                        | `recent_activity`   | `GET /api/audit`             |
| Question log + recurring knowledge gaps                | `recent_questions`  | `GET /api/questions`         |
| Create a folder                                        | `create_folder`     | `POST /api/dir`              |
| Move / rename a note or folder                         | `move_path`         | `PATCH /api/path`            |
| Delete a note or folder                                | `delete_path`       | `DELETE /api/path`           |
| Propose a create/update/delete for human review        | `propose_edit`      | `POST /api/proposals`        |
| List proposals + their status                          | `list_proposals`    | `GET /api/proposals`         |
| Review-queue approval rates + threshold nudges         | `proposal_stats`    | `GET /api/proposals/stats`   |
| List skill notes (procedural playbooks)                | `list_skills`       | `GET /api/skills`            |
| Run the dream-cycle maintenance scan                   | `run_maintenance`   | `POST /api/maintenance/scan` |
| Learn from reviewed draft→final outreach pairs         | `run_feedback`      | `POST /api/feedback/scan`    |

**Human-only (no MCP tool):** resolving a proposal — `POST /api/proposals/resolve`
(an `agent:` resolver is rejected `403`). **Live stream:** `GET /api/events` (SSE).
**Preview maintenance without filing:** `GET /api/maintenance`.
**Preview the feedback loop without filing:** `GET /api/feedback`.

Rules of thumb: **read/search before writing**; prefer `patch_note` over a full
`update_note`; and **propose** (don't write directly) anything a human should sign
off on. Tool arg shapes are in [`apps/mcp/README.md`](apps/mcp/README.md); endpoint
request/response shapes in [`apps/api/README.md`](apps/api/README.md).

---

## What's built (current surface)

Done and on `main`-track (details + status tables in `docs/implementation.md`):

- **Files & tree** — GitHub-style tree, CRUD for `.md` files and folders,
  optimistic-concurrency writes (`etag` / `lastModified`), `CONTENT_ROOT`
  sandboxing. Hidden dotfiles/dirs (e.g. `.fsbrain/`) are excluded from the tree.
- **Links & metadata** — `[[wikilinks]]` (clickable, resolved), a backlinks
  panel (`GET /api/backlinks`), and frontmatter + `#tags` parsing. The pure
  helpers live in `@repo/shared` (`markdown.ts`).
- **Rich rendering** — the preview uses `react-markdown` + `remark-gfm`
  (tables, task lists, strikethrough, autolinks, h3–h6), `remark-math` +
  `rehype-katex` (math), and highlight.js for fenced code (with a copy button).
  A fenced ` ```mermaid ` block renders as an **SVG diagram** (`MermaidDiagram`,
  mermaid lazy-imported so it stays out of the main bundle; degrades to source
  on error). Frontmatter is stripped and tags render as chips. Wikilinks are a
  remark plugin (`apps/web/src/markdown/remarkWikilinks.ts`).
- **Search** — full-text + tag search (`GET /api/search`), **semantic
  (relevance) search** (`GET /api/semantic-search`, TF-IDF cosine over chunked
  notes; `semantic.ts`), and **hybrid retrieval** (`GET /api/hybrid-search`)
  that fuses the two by Reciprocal Rank Fusion (`hybrid.ts`,
  `reciprocalRankFusion`) so neither exact keyword nor conceptual matches are
  missed. The Ctrl/Cmd-K quick-switcher has a Text|Semantic|Hybrid toggle
  (prefix `#` for tags in Text mode). All three run offline, no API key, on the
  TF-IDF ranker by default; the ranking engine is swappable for **real
  embeddings** (opt-in `FSBRAIN_EMBEDDINGS`, see the _Real embeddings_ entry
  below) behind the same `documents → ranked` contract, so nothing downstream
  changes.
- **Provenance** — mutations read an `X-Actor` header (default `human`) and are
  appended to an audit log (`CONTENT_ROOT/.fsbrain/audit.jsonl`), exposed via
  `GET /api/audit` and a web **Activity** tab with human-vs-agent badges.
- **Edit review queue** — instead of writing directly, an agent can submit a
  **proposal** (`POST /api/proposals`, or the `propose_edit` MCP tool) for a
  create/update/delete. A human reviews the before/after in the web **Review**
  tab and approves (the edit is applied and audited as the proposing agent) or
  rejects. Proposals live in `CONTENT_ROOT/.fsbrain/proposals/`. Both
  destructive paths (`update`, `delete`) honor `baseEtag` and 409 on a stale
  approval. Resolution is human-only — agents get `propose_edit` /
  `list_proposals`, the MCP server omits a resolve tool, and the API rejects an
  `agent:` resolver (403). This is convention-level (X-Actor is unauthenticated);
  airtight enforcement would need authn/z, intentionally out of scope for this
  local, single-user tool.
- **Review-queue learning** — every filed proposal carries a `category`
  (`maintenance:<kind>`, `feedback:<channel>`; ad-hoc ones fall back to
  `actor:action`). `proposal_stats` (`GET /api/proposals/stats`) tallies
  per-category approve/reject rates so an agent can learn the human's taste —
  back off categories that keep getting rejected. The pure helper
  (`@repo/shared` `proposalStats.ts`) also derives bounded threshold nudges the
  dream-cycle scan adopts on its own (see below). Resolution stays human-only;
  only the propensity to propose tunes.
- **Granular agent writes** — `PATCH /api/file` (or the `patch_note` MCP
  tool) applies `append`, `prepend`, `replace_section`, `replace_block`, or
  `ensure_id` ops without rewriting the whole note. It reuses the `etag`
  optimistic-concurrency contract, accepts an `idempotencyKey` so a retried
  patch is a no-op (keys cached in memory for the API process lifetime), and
  supports `dryRun` to preview the result without writing or auditing. The
  pure text-transform helpers live in `@repo/shared` (`patch.ts`).
- **Structured knowledge** — Obsidian-style **block anchors** (`^id`) give
  agents stable, citable addresses inside a note: `GET /api/block` /
  `GET /api/block-anchors` (and the `read_block` / `get_block_anchors` MCP
  tools) read by block; the `replace_block` patch op overwrites a block,
  reattaching the anchor so future reads still resolve. A frontmatter
  **`id:`** is the note's stable identity (opt-in via the `ensure_id` patch
  op), accepted as `?id=` on `/api/file` / `/api/block` reads and on the
  patch endpoint. **Typed wikilinks** `[[Target|rel:supports]]` surface a
  relation on `/api/backlinks` (plain aliases still work). Pure helpers live
  in `@repo/shared` (`blocks.ts`, `noteId.ts`).
- **Knowledge graph** — the vault's `[[wikilink]]` graph is rendered as an
  interactive, force-directed **Graph** tab in the web UI (click a node to open
  the note, hover to highlight its neighbors, unresolved link targets shown as
  distinct placeholders, live-refreshed on vault changes) and exposed for agent
  traversal at `GET /api/graph` (and the `get_graph` MCP tool) as `GraphData`
  (`{ nodes: { id, label, tags, unresolved? }, edges: { source, target, type? } }`).
  It is built from the same link extraction as backlinks, served from the cached
  index, and excludes `.fsbrain/`. Edges **self-wire from frontmatter**: any
  field whose value holds a `[[link]]` (e.g. `related: [[Foo]]`) becomes a typed
  edge with the field name as `type` — no manual `[[Foo|rel:related]]` needed.
  The pure builder lives in `@repo/shared` (`graph.ts`,
  `extractFrontmatterRelations`); the renderer (`apps/web` `KnowledgeGraph`) is
  lazy-loaded.
- **MCP server** (`apps/mcp`) — a stdio server exposing 26 vault tools
  (`list_notes`, `read_note`, `read_block`, `get_block_anchors`,
  `create_note`, `update_note`, `patch_note`, `search_notes`,
  `semantic_search`, `hybrid_search`, `get_context`, `think`, `get_backlinks`,
  `get_graph`, `schema_pack`, `recent_activity`, `recent_questions`,
  `create_folder`, `move_path`, `delete_path`, `propose_edit`, `list_proposals`,
  `proposal_stats`, `list_skills`, `run_maintenance`, `run_feedback`). It runs
  the storage API **in-process** by default, so it is a single
  self-contained command an MCP host (OpenClaw, Claude Desktop, Claude
  Code, Cursor) can spawn — `npm run start:agent` from the repo root, or
  the bundled `node apps/mcp/dist/server.js`. Copy-paste host configs live
  in [`docs/CONNECT.md`](docs/CONNECT.md). On startup it prints a one-line
  readiness banner on stderr (`fsbrain-mcp ready · mode=… · vault=… ·
tools=… · actor=…`) so a host log immediately shows whether the spawn
  worked. Agent writes carry `X-Actor: agent:mcp` (override via
  `MCP_ACTOR`) and flow through the same validation, optimistic-
  concurrency, and audit trail as the web UI.
- **Clone-and-run guarantee** — `apps/mcp/src/__tests__/freshClone.test.ts`
  spawns the MCP bin as a real stdio child against a temp `CONTENT_ROOT`,
  drives it via the official MCP SDK client (tools/list + create/read/
  search/semantic_search + propose_edit/list_proposals + recent_activity),
  and asserts the write landed both on disk and in the audit log. Runs in
  `npm test`, so a green test bar is the proof that a fresh clone works.
- **Live layer** — the web UI reflects vault changes the moment they happen.
  An in-process `EventBus` (`apps/api/src/events/`) gets a `VaultEvent` from
  every mutating handler right beside its audit write, and a recursive
  `fs.watch` watcher publishes `source:'watch'` events for out-of-band edits
  (direct file edits, `git`, another process) — ignoring `.fsbrain/` and
  non-`.md` churn and de-duping against API writes. `GET /api/events` streams
  these over SSE; the web `useVaultEvents` hook subscribes and surgically
  refreshes the tree, the open file (preserving unsaved drafts), the Activity
  feed, and the Review badge, with a live/reconnecting indicator. The embedded
  API the MCP server launches starts the bus + watcher too, so an agent's
  writes surface to a watching human in real time.
- **RAG retrieval — cached index + context bundles** — a first-class retrieval
  layer for agents. An in-memory `VaultIndex` (`apps/api/src/index/`) chunks
  every note and computes IDF + per-chunk vectors once, reusing them across
  queries; it subscribes to the live-layer `EventBus` so any create/update/
  move/delete invalidates it and the next query rebuilds from disk (reusing
  cached content of unchanged notes) — never stale after a write. Both
  `/api/search` and `/api/semantic-search` read through it. `GET /api/context`
  (and the `get_context` MCP tool) assembles a token-budgeted **context
  bundle**: the top query-ranked passages plus — for a focus note — that note
  and its backlinks as neighbor context, de-duped and packed to a token budget
  (`ceil(chars/4)`, no tokenizer). Stays fully local/offline; the bundle-shaping
  helpers are pure (`@repo/shared` `context.ts`) and the ranking engine is
  pluggable — TF-IDF by default, **real embeddings** when opted in (see below) —
  behind the same `documents → ranked` contract.
- **Brain layer — `think` (cited answers + offline gap analysis)** — turns a
  question into a **grounded answer kit** instead of raw pages. `GET /api/think`
  (and the `think` MCP tool) runs hybrid retrieval, assembles a context bundle,
  and returns numbered **citations** (`[1]`, `[2]`…) mapped to source passages
  (path + heading + `^block` anchor), the passages, and a deterministic,
  **offline gap analysis** (`weakCoverage` + `uncoveredTerms` — "what the vault
  doesn't yet cover"), computed from retrieval scores with **no model**. The
  kit-shaping is pure (`@repo/shared` `think.ts` — `assembleAnswerKit`). Offline
  by default: the calling agent is the LLM and composes the final cited answer
  from the kit; a server-side `OPENROUTER_API_KEY` + `?synthesize=1` optionally
  adds a synthesized prose `answer`.
- **Dream-cycle maintenance** — a deterministic, offline scan
  (`@repo/shared` `maintenance.ts`, `scanVault`) finds vault-hygiene problems —
  **broken `[[wikilinks]]`**, **orphan notes**, **near-duplicate notes**
  (note-level TF-IDF cosine), **stale-but-load-bearing notes** (heavily
  linked yet unchanged for > 90 days — report-only, "is this still accurate?";
  the route feeds `scanVault` per-note mtimes + a `now` reference), and
  **schema violations** (report-only; see "Schema packs" below) — and files
  each actionable one as an **edit proposal** the human approves in the Review
  tab (reusing the `ProposalStore` + `EventBus`). `GET /api/maintenance`
  previews; `POST /api/maintenance/scan` (and the `run_maintenance` MCP tool)
  files suggestions as a distinct `agent:maintenance` actor and is
  **idempotent** — it dedupes against pending _and_ rejected proposals, so
  re-running never spams the queue or re-surfaces a declined fix. The
  duplicate-detection threshold **self-tunes** from the review queue's
  `maintenance:duplicate` approve/reject history (see "Review-queue learning").
  On-demand by default (optional `MAINTENANCE_INTERVAL_MS` timer). Resolution
  stays human-only; contradiction detection is a deferred follow-up (it needs an
  LLM, out of the offline scope).
- **Retrieval eval harness** — a golden `query → expected-note` fixture
  (`apps/api/src/__tests__/fixtures/retrievalCorpus.ts`) is run against the
  real `/api/search`, `/api/semantic-search`, and `/api/hybrid-search` stacks
  in `npm test`, with pinned per-engine recall floors (hybrid must retrieve
  every expected note). Pure metric helpers (recall@k, MRR@k) live in
  `@repo/shared` (`retrievalEval.ts`). A ranking change that regresses recall
  fails the suite and names the broken queries — extend the fixture when you
  add ranking behavior; never lower a floor to ship.
- **Skill notes — procedural memory** — a note with frontmatter `type: skill`
  (plus optional `name:` / `description:`) is a reusable playbook: goal,
  steps, gotchas. `GET /api/skills` (and the `list_skills` MCP tool, with an
  optional `query` filter) lists them from the cached index; reading one is a
  plain `read_note`, and contributing one is a `propose_edit` the human
  approves — so the skill library grows from real agent work, with review.
  If you are an agent working in this vault: **check `list_skills` before a
  non-trivial task, and propose a skill note after learning a reusable
  procedure.** Pure helpers in `@repo/shared` (`skills.ts` — `parseSkill`,
  `listSkills`).
- **Schema packs — typed page types** — `@repo/shared` `schema.ts`
  (`DEFAULT_SCHEMA_PACK`) defines canonical note `type:` values (person,
  meeting, project, idea…), each with a colour and the typed **frontmatter**
  relations it may declare (`meeting.attendees → person`, `project.owner →
person`). `GET /api/schema` (and the `schema_pack` MCP tool) returns
  `{ pageTypes }`. Three payoffs off metadata the vault already stores: the
  Graph view **colours** a node by its `type` (schema colour wins over first
  tag); `validateVault` **flags** an unknown type or a disallowed/mis-targeted
  relation as a report-only `schema` maintenance finding for human review; and
  the pack lets agents author **well-typed** notes. If you are an agent:
  **consult `schema_pack` before creating or editing a note** so you pick a
  canonical `type:` and only wire relations that type permits. All
  pure/offline; retrieval boosting on the same metadata is a documented
  follow-on, not wired yet.
- **Question log — demand-driven gaps** — every `think` query is persisted
  with its offline gap signal (`weakCoverage` + `uncoveredTerms`) to
  `CONTENT_ROOT/.fsbrain/questions.jsonl`, beside the audit log.
  `GET /api/questions` (and the `recent_questions` MCP tool) returns the
  recent entries plus **recurring knowledge gaps** — terms that keep going
  uncovered across questions (pure `findKnowledgeGaps` in `@repo/shared`
  `questions.ts`). A recurring gap means the vault keeps being asked
  something it can't answer: if you are an agent and know the missing
  material, `propose_edit` a note that fills it. Logging is best-effort and
  never fails the `think` call.
- **Outreach feedback loop** (`@repo/shared` `feedback.ts`, `scanFeedback`) closes
  the "learn from human review" loop: a note with frontmatter `type: feedback`
  links an agent `draftPath` to the approved `finalPath` for a `channel`
  (`x` / `linkedin` / `email`), and the scan distills the **diff** (what the human
  removed/added, how much shorter, plus any `reviewReason`) into a deterministic
  lesson, filed as an **edit proposal** that grows a channel playbook (default
  `feedback/<channel>.md`, a `type: skill` note). `GET /api/feedback` previews;
  `POST /api/feedback/scan` (and the `run_feedback` MCP tool) files as a distinct
  `agent:feedback-loop` actor. **Idempotent** — dedupes against pending/rejected
  proposals, and a per-pair marker keeps an approved lesson from re-filing. No
  draft is ever posted or sent; the lesson is a mechanical summary, not an
  LLM-written rule (on-demand by default, optional `FEEDBACK_INTERVAL_MS` timer).
- **Real embeddings — opt-in vector retrieval** — the retrieval engine behind
  `VaultIndex` is a pluggable seam (`apps/api/src/index/retrievalEngine.ts`) with
  two interchangeable implementations: **TF-IDF** (default, offline, no key) and
  **embeddings** (opt-in), which chunks the corpus with the _same_ chunker, embeds
  each chunk via an OpenAI-compatible `/v1/embeddings` provider, and ranks by
  dense cosine. Both return identical `SemanticHit`/`RankedChunk` shapes, so
  `semantic_search`, `hybrid_search`, `think`, and `get_context` are unchanged —
  only the scoring improves on synonyms/paraphrase. The toggle is a single env
  var, **`FSBRAIN_EMBEDDINGS`** (off by default), plus `EMBEDDINGS_API_KEY` (falls
  back to `OPENROUTER_API_KEY`) and optional `EMBEDDINGS_MODEL` / `EMBEDDINGS_URL`
  / `EMBEDDINGS_BATCH_SIZE`. It is **resilient**: a build failure (bad key, no
  network) or a transient per-query embed error degrades to the TF-IDF ranker
  over the same corpus rather than breaking search, so "off" is always a working
  search. Chunk vectors are **content-addressed** (sha-256 of the embeddable text
  → vector) and **persisted** to `CONTENT_ROOT/.fsbrain/embeddings.json` (atomic
  temp+rename, pruned to the live corpus, tagged with the model so a model switch
  invalidates cleanly), so a restart re-embeds only changed chunks. Persistence
  is best-effort — a missing/corrupt/wrong-model file loads as empty and a save
  failure just means a colder cache, never a failed build. The pure dense-ranking
  math lives in `@repo/shared` (`embeddings.ts`); the only I/O is a tiny `fetch`
  client (`apps/api/src/embeddings/`), mirroring `think`'s OpenRouter wiring. An
  eval harness (`embeddingEval.test.ts`) proves the semantic-over-lexical win
  offline (a controlled concept-embedder retrieves cases that share a concept but
  **zero tokens** with the query; TF-IDF retrieves none).

**Not yet built (next):** see the roadmap in `docs/implementation.md` — the
core retrieval and self-improvement surface (search, embeddings, RAG, `think`,
maintenance, feedback) is now in place.

---

## Repository map (quick orientation)

```
apps/
  api/   # Node HTTP server + filesystem storage (CONTENT_ROOT). Endpoints under /api/*.
         # events/ (live SSE), index/ (cached retrieval VaultIndex behind search/context).
  web/   # React + Vite UI: file tree, editor/preview/activity tabs, Ctrl/Cmd-K search.
  mcp/   # MCP stdio server exposing the vault as agent tools. Embeds the API in-process
         # by default; bundled to a single bin (`apps/mcp/dist/server.js`, npm `fsbrain-mcp`).
packages/
  shared/  # Shared TS contracts + pure utilities: markdown.ts, search.ts, semantic.ts,
           # context.ts (token-budgeted bundle packing), graph.ts (wikilink graph).
docs/      # Agent + human knowledge base. Start at implementation.md.
```

- `@repo/shared` is consumed **as source** (`main: src/index.ts`). It has no test
  runner of its own — co-locate its unit tests in `apps/api` (node vitest).
- The API is **markdown-focused** and sandboxed to `CONTENT_ROOT`; path handling
  rejects traversal and absolute paths. Keep those guarantees intact.
- **Provenance is a guarantee, not an option:** any new mutating path must read
  `X-Actor` and record an `AuditEntry`. Don't add writes that bypass the log.
- **When the human should sign off on a change, propose it** (`propose_edit` /
  `POST /api/proposals`) rather than writing directly. Resolving proposals is
  human-only; don't add an agent path that approves them.
- Relative imports under the API/MCP packages (NodeNext) use explicit `.js`
  extensions. `npm run build` is green across all workspaces — keep it green.

---

## Operating Rules

### Think before coding

- State assumptions.
- Surface tradeoffs.
- Ask before guessing.
- Push back when a simpler approach exists.

### Simplicity first

- Write the minimum code that solves the problem.
- No speculative features.
- No abstractions for one-off code.

### Surgical changes

- Touch only what is necessary.
- Do not refactor adjacent code.
- Match existing style.

### Goal-driven execution

- Define success criteria.
- Verify before claiming completion.
- Iterate until the goal is met.

---

## Claude Code Rules

### Prevent agent fights

- Do not run multiple agents against the same files unless explicitly asked.
- Before using subagents, state ownership boundaries.

### Avoid hook cascades

- Before editing hooks, inspect existing hooks.
- Do not add hooks that trigger other hooks without explaining the chain.

### Control skill loading

- Load only skills relevant to the current task.
- Do not invoke broad skills when a simple edit is enough.

### Preserve workflow state

- For multi-step work, keep a brief checklist.
- Before compacting or ending a session, summarize current state, blockers, and
  next step.

### Verify with project commands

- Prefer existing test, lint, typecheck, and build commands.
- Do not invent commands when package scripts or Make targets exist.

### Protect local and secret files

- Do not edit `.env`, secrets, credentials, local configs, or generated files
  unless explicitly asked.

### Respect repo boundaries

- In monorepos, identify the package/app being changed before editing.
- Do not apply conventions from one package to another without checking.

### Escalate uncertainty

- If instructions conflict, stop and ask.
- If a change has security, data-loss, migration, or production-risk
  implications, call that out before editing.

---

## Project commands (do not invent new ones)

```bash
npm install        # install workspaces
npm run dev:api    # run API   (http://localhost:3001)
npm run dev:web    # run web UI (http://localhost:5173)
npm run start:agent  # launch the self-contained MCP server (`fsbrain-mcp`, stdio)
npm run doctor     # preflight: Node version + vault writable
npm test           # run all workspace tests (vitest), incl. fresh-clone MCP e2e
npm run lint       # eslint
npm run build      # tsc/vite/esbuild build across workspaces (produces the MCP bin)
npm run format     # prettier --check
```

When you finish a change: run `npm test`, `npm run lint`, and `npm run build`,
then update `docs/implementation.md` to reflect the new state.
