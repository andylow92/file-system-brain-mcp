# Implementation Status

> **Audience: AI agents (and humans) working on this repo.**
> This is the source of truth for _where we are_ and _what's next_.
> Keep it accurate: update the status tables when you finish a unit of work.
> Routed from [`AGENTS.md`](../AGENTS.md).

_Last updated: 2026-06-28 (review-queue learning + freshness scoring)_

> **Latest change.** Two more self-improvement loops from
> [`improvement-ideas.md`](improvement-ideas.md) (#2, #5), both pure/offline/
> deterministic and human-gated. **(1) Review-queue learning.** Every filed
> proposal now carries a `category` (`maintenance:<kind>`, `feedback:<channel>`;
> ad-hoc ones fall back to `actor:action`). A pure helper in `@repo/shared`
> (`proposalStats.ts` — `summarizeOutcomes`, `recommendThreshold`) tallies
> per-category approve/reject rates and derives **bounded, sample-floor-guarded**
> threshold nudges. `GET /api/proposals/stats` + the `proposal_stats` MCP tool
> (25th) return `{ categories, recommendations }`; `runMaintenanceScan`
> **self-tunes** its duplicate-detection cosine from the `maintenance:duplicate`
> history (raise when rejected, lower when approved), echoed as `tuning`.
> **(2) Freshness scoring.** `scanVault` gains a `stale` finding — a load-bearing
> note (≥ 3 inbound `[[wikilinks]]`) unchanged for > 90 days, surfaced report-only
> for an "is this still accurate?" review. Opt-in via new `now` + `modifiedAt`
> options (the API derives mtimes via `fs.stat`); omit `now` and every prior
> caller is unchanged. Reads aren't logged, so inbound-citation count is the
> deterministic stand-in for retrieval frequency. Resolution stays human-only
> throughout. Covered by `apps/api` `__tests__/proposalStats.test.ts` and
> `routes/proposalStats.test.ts`, plus freshness cases in
> `__tests__/maintenance.test.ts` and an `utimes`-aged case in
> `routes/maintenance.test.ts`.

> **Latest change.** The vault now runs an **outreach feedback loop** — it learns
> from human review of its own drafts. A note with frontmatter `type: feedback`
> links an agent `draftPath` to the approved `finalPath` for a `channel`
> (`x` / `linkedin` / `email`), optionally with a `targetPath` playbook and a
> free-text `reviewReason`. A pure helper in `@repo/shared` (`feedback.ts` —
> `scanFeedback`, `parseFeedbackPairing`, `diffDraftFinal`) distills the
> draft→final **diff** (words trimmed, phrases removed/added, the reason) into a
> deterministic lesson and suggests growing the playbook (default
> `feedback/<channel>.md`, created as a `type: skill` note). `GET /api/feedback`
> previews; `POST /api/feedback/scan` (and the 24th MCP tool, `run_feedback`)
> files each lesson as a proposal attributed to a distinct `agent:feedback-loop`
> actor, returning `{ findings, proposalsFiled }`. **Idempotent** — it dedupes
> against pending _and_ rejected proposals, and a per-pair marker keeps an
> approved lesson from re-filing; an `update` carries the target's `baseEtag`. No
> draft is ever posted or sent, and the lesson is a mechanical summary rather than
> an LLM-written rule (on-demand by default, optional `FEEDBACK_INTERVAL_MS`
> timer). The third self-improvement loop after skill notes and the question log.
> Covered by `apps/api` `__tests__/feedback.test.ts` (pure: pairing parse, diff,
> create/update/missing/no-change/already-learned, multi-channel ordering) and
> `routes/feedback.test.ts` (endpoint: preview vs file, attribution, idempotent
> re-scan, x/linkedin/email); the MCP smoke + fresh-clone tests assert the
> 25-tool surface.

> **Latest change.** The vault now keeps a **question log** — it learns what it
> gets asked but cannot answer (the second self-improvement loop from
> [`improvement-ideas.md`](improvement-ideas.md), #3). Every `GET /api/think`
> query is persisted with its offline gap signal (`weakCoverage` +
> `uncoveredTerms`, attributed via `X-Actor`; the MCP `think` tool now sends its
> actor) to `CONTENT_ROOT/.fsbrain/questions.jsonl`, beside the audit log — a
> `QuestionLog` store mirroring `AuditLog`. Logging is **best-effort**: a log
> failure never fails the answer. A pure helper in `@repo/shared`
> (`questions.ts` — `findKnowledgeGaps`, `QuestionEntry`, `KnowledgeGap`)
> distills the log into **recurring knowledge gaps**: terms left uncovered by ≥
> `minCount` questions (default 2; repeats of the same question count — asking
> twice is demand), sorted by frequency with de-duplicated example queries.
> `GET /api/questions?limit&minCount` (and the 23rd MCP tool,
> `recent_questions`) returns `{ entries, gaps }` — entries newest-first, gaps
> computed over the whole log regardless of the page size. The tool description
> closes the loop: a recurring gap is a demand-driven prompt to `propose_edit` a
> note that fills it (human-approved, as always). Covered by `apps/api`
> `__tests__/questions.test.ts` (pure: grouping, repeat-demand, per-entry term
> dedupe, minCount/sort, example cap, empty log) and `routes/questions.test.ts`
> (endpoint: persistence + actor attribution, gap distillation, limit vs.
> whole-log recurrence); the MCP smoke + fresh-clone tests assert the 23-tool
> surface.

> **Latest change.** The vault now has **skill notes** — procedural memory the
> agent grows itself (the first self-improvement loop from
> [`improvement-ideas.md`](improvement-ideas.md)). A note whose frontmatter
> declares `type: skill` (plus optional `name:` / `description:`) is a reusable
> playbook: goal, steps, gotchas. A pure helper in `@repo/shared` (`skills.ts`
> — `parseSkill`, `listSkills`, `SkillSummary`) recognizes and summarizes them
> (name falls back to the first heading then the filename; description to the
> first body paragraph line). `GET /api/skills?q=...` (and the 22nd MCP tool,
> `list_skills`, with an optional `query` filter) lists them from the cached
> `VaultIndex`. Deliberately **no new write path**: reading a skill is
> `read_note`, and contributing one is a `propose_edit` the human approves in
> the Review tab — the tool description nudges the agent to check for a skill
> before a non-trivial task and to distill a new one after learning a reusable
> procedure, so the playbook library grows from real work, with review.
> Covered by `apps/api` `__tests__/skills.test.ts` (pure: type marker,
> fallbacks, filtering) and `routes/skills.test.ts` (endpoint: skill-only
> listing, `q` filter, no-stale-after-write); the fresh-clone MCP test asserts
> the 22-tool surface.

> **Latest change.** The vault now runs a **dream-cycle maintenance** scan that
> finds hygiene problems and files each actionable one as a **proposal** the
> human approves in the Review tab — reusing the `ProposalStore` + `EventBus` we
> already ship, no new subsystem. A pure, deterministic helper in `@repo/shared`
> (`maintenance.ts` — `scanVault`, `MaintenanceFinding`) detects, **fully
> offline** (no model, no API key): **broken links** (a `[[wikilink]]` resolving
> to no note → suggest a `create` stub of the missing target), **orphans** (a
> note with no inbound/outbound _resolved_ links → report-only, no auto-edit),
> and **near-duplicates** (a pair of notes whose note-level TF-IDF cosine ≥ a
> threshold → suggest an `update` that appends a conservative
> `> See also [[other]]` cross-link, never a merge). Each suggestion is a safe,
> reversible `{ action, path, content?, note }` that maps 1:1 onto a proposal.
> `GET /api/maintenance` is a dry preview (scan the cached `VaultIndex`, file
> nothing); `POST /api/maintenance/scan` (and the `run_maintenance` MCP tool —
> see below) files each suggestion as a proposal attributed to a distinct
> `agent:maintenance` actor and returns `{ findings, proposalsFiled }`. It
> **dedupes against pending _and_ rejected proposals** (match on action+path) so
> re-running is idempotent — it never spams the Review queue nor re-surfaces a fix
> the human already declined. An `update` suggestion (the duplicate cross-link,
> whose content is a full-note snapshot) is filed with the target's current
> `baseEtag`, so approving it after the note changed `409`s instead of clobbering
> the edit. Scheduling is on-demand by
> default; an optional `MAINTENANCE_INTERVAL_MS` timer in `createServer` runs it
> periodically when set. **Resolution stays human-only** — there is no agent
> approval path. A light **Maintenance** action sits atop the web Review tab (run
> a scan, see findings grouped by kind; filed fixes appear as proposals just
> below). Contradiction detection is intentionally **out of scope for v1** (it
> needs an LLM, which breaks the offline guarantee) and is left as a follow-up
> behind the same server-side `OPENROUTER_API_KEY` gate as `think`'s synthesis.
> Covered by `apps/api` `__tests__/maintenance.test.ts` (pure: each finding kind,
> threshold boundary, clean vault → [], determinism, empty corpus) and
> `routes/maintenance.test.ts` (dry preview files nothing, scan files as
> `agent:maintenance`, idempotent re-run, duplicate cross-link); the fresh-clone
> MCP test now asserts the 21-tool surface and exercises `run_maintenance`. This
> is the third gbrain-inspired enhancement (item #17; see _Next up_).

> **Latest change.** The vault now has a **`think`** brain layer: "search gives
> raw pages, the brain gives the answer." `GET /api/think` (and the 20th MCP tool,
> `think`) runs **hybrid retrieval** (fuse lexical + semantic by RRF so neither
> exact-keyword nor conceptual matches are missed), assembles a token-budgeted
> context bundle from the fused passages, and returns a **grounded answer kit**:
> numbered **citations** (`[1]`, `[2]`…) mapped to each source passage (path +
> heading + `^block` anchor when present), the passages themselves, and a
> deterministic, **offline gap analysis** — `weakCoverage` (the best match score
> fell below a threshold, or nothing matched) plus `uncoveredTerms` ("what the
> vault doesn't yet cover"), computed from retrieval scores + stem-aware term
> coverage with **no model**. The kit-shaping is a pure, dependency-free helper in
> `@repo/shared` (`think.ts` — `assembleAnswerKit`, `AnswerKit`). The endpoint
> stays **fully offline by default**: the agent calling the MCP tool is itself the
> LLM and composes the final cited answer from the kit. Only when an OpenRouter
> key is configured **server-side** (`OPENROUTER_API_KEY`, mirroring the web
> app's wiring) _and_ the request opts in (`?synthesize=1`) does it also include a
> synthesized prose `answer` that cites the numbered sources — and a synthesis
> failure never fails the offline kit. Covered by `apps/api` `__tests__/think.test.ts`
> (pure: multi-citation mapping, weak-coverage flag, stem-aware uncovered-term
> detection, empty corpus) and `routes/think.test.ts` (endpoint: 422 on empty
> `q`, grounded citations, gap reporting, focus-note neighbors, offline gate); the
> fresh-clone + smoke MCP tests now assert the 20-tool surface and exercise
> `think`. This is the second gbrain-inspired enhancement (item #16; see _Next up_).

> **Latest change.** Retrieval is now **hybrid**. The two engines that already
> existed — lexical full-text (`search.ts`, exact keyword/filename) and semantic
> TF-IDF cosine (`semantic.ts`, relevance) — are fused by **Reciprocal Rank
> Fusion** so a note found by either, or modestly by both, ranks well. The fusion
> is a pure, dependency-free, deterministic helper in `@repo/shared`
> (`hybrid.ts` — `reciprocalRankFusion`, `HybridHit`); it combines lists by rank
> position, so the engines' non-comparable scores never need normalizing. A new
> `GET /api/hybrid-search` (and the 19th MCP tool, `hybrid_search`) returns
> `HybridHit[]` (`path`, `name`, `score`, `snippet`, `heading?`, `line`, `tags`,
> `sources: ("text"|"semantic")[]`), reading both engines through the cached
> `VaultIndex` (no extra vault re-read) and preferring the exact lexical line as
> the display snippet. The web Ctrl/Cmd-K switcher gains a **Hybrid** mode
> alongside Text|Semantic. Stays fully local/offline — no model or API key.
> Covered by `apps/api` `hybrid.test.ts` (pure RRF: multi-list reward, weights,
> tie-break determinism, deduped ranks) and `routes/hybridSearch.test.ts`
> (endpoint: keyword+semantic fusion, semantic-only tags, limit, no-stale-after-
> write); the fresh-clone + smoke MCP tests now assert the 19-tool surface and
> exercise `hybrid_search`. This is the first of the gbrain-inspired enhancements
> (see _Next up_).

> **Latest change.** The vault's `[[wikilink]]` **knowledge graph** is now
> visible to the human and traversable by agents — the last human-facing item on
> the roadmap, so the planned roadmap is **complete**. A pure builder in
> `@repo/shared` (`graph.ts` — `buildGraph`) turns the note corpus into
> `GraphData` (`{ nodes: { id, label, tags, unresolved? }, edges: { source,
target, type? } }`) using the same link extraction (`extractWikilinks` +
> `resolveWikilink`) that backs `/api/backlinks`, so the graph and backlinks can
> never disagree. Unresolved link targets become distinct placeholder nodes
> (`unresolved: true`); the typed relation from `[[Target|rel:type]]` rides on
> the edge. `GET /api/graph` (and the 18th MCP tool, `get_graph`) serves it from
> the cached `VaultIndex` (no per-call vault re-read; `.fsbrain/` excluded). In
> the web UI a new **Graph** tab renders a dependency-free, force-directed SVG
> (`apps/web` `KnowledgeGraph`, lazy-loaded; layout in `graphLayout.ts`): click a
> node to open the note, hover to highlight its neighbors, unresolved nodes are
> styled distinctly, with pan/zoom — and it live-refreshes (debounced) off the
> existing `/api/events` stream. Covered by `apps/api` `graph.test.ts` (pure
> builder) + `routes/graph.test.ts` (endpoint, unresolved placeholder, no-stale-
> after-write) and `apps/web` `GraphView.test.tsx` (renders nodes, click opens).

> **Latest change.** The vault is now a first-class **RAG source** for agents.
> An in-memory `VaultIndex` (`apps/api/src/index/vaultIndex.ts`) chunks every
> note and computes the IDF + per-chunk TF-IDF vectors **once**, reusing them
> across queries instead of re-reading the whole vault per request. It
> subscribes to the live-layer `EventBus`, so any create/update/move/delete
> (API or out-of-band) invalidates it and the next query rebuilds from disk —
> reusing the cached content of unchanged notes — and never serves stale results
> after a write. Both `/api/search` and `/api/semantic-search` read through it
> (ranking unchanged). A new **context-bundle** endpoint `GET /api/context`
> (and the `get_context` MCP tool) assembles a token-budgeted bundle: the top
> query-ranked passages (`kind:"match"`) plus — when a `path` focus note is
> given — that note and its backlinks (`kind:"neighbor"`), de-duped and packed
> to a token budget (`ceil(chars/4)`, no tokenizer). Stays fully local/offline;
> the bundle-shaping is pure + tested in `@repo/shared` (`context.ts`) and the
> ranking engine stays swappable for real embeddings behind the same
> `documents → ranked` contract.

> **Latest change.** The web UI now reflects vault changes **the instant they
> happen**. An in-process `EventBus` (`apps/api/src/events/`) receives a
> `VaultEvent` from every mutating handler — published right beside the audit
> write so the stream and the audit log never diverge — and a recursive
> `fs.watch` watcher publishes `source:'watch'` events for out-of-band edits
> (a direct file edit, `git`, another process), ignoring `.fsbrain/` and
> non-`.md` churn and de-duping against API writes. `GET /api/events` streams
> these over Server-Sent Events; the web `useVaultEvents` hook subscribes and
> surgically refreshes the tree, the open file (preserving unsaved drafts —
> showing a non-destructive "changed on disk" prompt instead of clobbering),
> the Activity feed, and the Review badge, with a live/reconnecting indicator.
> The MCP server's embedded API starts the bus + watcher too, so an agent's
> writes surface to a watching human live.

> **Latest change.** The project is now **clone-and-run testable** for an
> agent. `npm run start:agent` launches the self-contained `fsbrain-mcp` —
> when `API_BASE_URL` is unset it starts the storage API in-process on
> `127.0.0.1` (ephemeral port), auto-creates `CONTENT_ROOT` (default
> `~/.fsbrain/vault`), seeds a `welcome.md` on an empty vault, prints a
> one-line readiness banner to stderr, and bundles to a runnable
> `dist/server.js` (npm bin `fsbrain-mcp`). Copy-paste host configs for
> OpenClaw / Claude Desktop / Claude Code / Cursor live in
> [`CONNECT.md`](CONNECT.md). The guarantee is enforced by an automated
> fresh-clone e2e test (`apps/mcp/src/__tests__/freshClone.test.ts`) that
> spawns the bin as a real stdio child against a temp vault, drives it via
> the MCP SDK client, and asserts writes land both on disk and in the audit
> log — runs in `npm test`.
>
> **Heads-up for existing local setups.** The default `CONTENT_ROOT` moved
> from `<cwd>/content` to `~/.fsbrain/vault`. Existing `./content` notes
> aren't deleted, but `npm run dev:api` / `dev:web` without `CONTENT_ROOT`
> set will now read the new path. Set `CONTENT_ROOT=./content` (e.g. in
> `apps/api/.env` or your shell) to keep the old location.

> **Latest change.** The MCP server is now a **single-command launcher**: when
> `API_BASE_URL` is unset it starts the storage API in-process on `127.0.0.1`
> (ephemeral port), auto-creates `CONTENT_ROOT` (now defaulting to
> `~/.fsbrain/vault`), seeds a `welcome.md` when launched against an empty
> vault, and bundles to a runnable `dist/server.js` (npm bin `fsbrain-mcp`).
> This is what OpenClaw / Claude Desktop spawn — see
> [`apps/mcp/README.md`](../apps/mcp/README.md) for the copy-paste config.
>
> **Heads-up for existing local setups.** The default `CONTENT_ROOT` moved
> from `<cwd>/content` to `~/.fsbrain/vault`. Existing `./content` notes
> aren't deleted, but `npm run dev:api` / `dev:web` without `CONTENT_ROOT`
> set will now read the new path. Set `CONTENT_ROOT=./content` (e.g. in
> `apps/api/.env` or your shell) to keep the old location.

---

## 1. Vision

A **local-first markdown workspace** that doubles as a **shared brain**:

- **For humans** — navigate like a GitHub repo, edit like a modern docs tool,
  with files stored as plain `.md` (never locked in a database).
- **For agents** — a machine-readable substrate agents can read, search, link,
  and write, where **every agent action stays visible to the human**.

We are closing two gaps in parallel: _Obsidian-for-humans_ (linking, search,
real rendering) and _agent-brain_ (machine API, retrieval, provenance).

---

## 2. Architecture map

```
apps/web (React + Vite)          apps/api (Node HTTP)             packages/shared
  GlobalLayout / FileTreeSidebar   /api/tree     list dir tree      FileNode, Api* contracts
  FileViewerTabs (Prev|Edit|Split| /api/file     read/create/update markdown.ts (links/tags,
    Activity|Review|Graph)         /api/file PATCH  granular edits    typed `rel:` aliases)
  MarkdownPreviewPane (react-      /api/dir      create folder      patch.ts (append/prepend/
    markdown: GFM/math/highlight   /api/path     move / delete       replace_section/_block,
    + wikilinks + ^block-anchors)  /api/backlinks        link graph    ensure_id)
  GraphView / KnowledgeGraph       /api/graph            wikilink graph graph.ts (buildGraph,
    (force-directed, lazy-loaded)  /api/block            block read    GraphData nodes/edges)
  BacklinksPanel / ActivityPanel   /api/block-anchors    list ^ids  blocks.ts (^id helpers)
  SearchDialog (Text|Semantic)                                      noteId.ts (stable id)
  ReviewPanel (proposals)          /api/search           full-text  search.ts  (text match)
  api/files.ts (HTTP client)       /api/semantic-search  ranked     semantic.ts (TF-IDF)
  hooks/useVaultEvents (SSE)       /api/audit            provenance markdown/remarkWikilinks.ts
  openrouter/ (Fix Format)         /api/proposals[/resolve]  review queue VaultEvent contract
                                   /api/events     live SSE stream of VaultEvents
                                   /api/context    token-budgeted RAG bundle context.ts (estimate
                                   storage/ (FileRepository, PathResolver,       tokens, pack budget,
                                              AuditLog, ProposalStore, IdempotencyCache)  shape bundle)
                                   events/ (EventBus, fs.watch watcher, SSE handler) semantic.ts
                                   index/ (VaultIndex: cached chunks+IDF,            (buildSemanticIndex,
                                           EventBus-invalidated, lazy rebuild)        queryRankedChunks)

apps/mcp (MCP stdio server, 25 tools) — exposes the vault to agents: list/read/
  create/update/patch/search/semantic_search/hybrid_search/get_context/think/
  backlinks/get_graph/recent_activity/move/delete plus read_block,
  get_block_anchors, propose_edit + list_proposals + run_maintenance +
  run_feedback. When
  API_BASE_URL is unset, runs the storage API in-process on 127.0.0.1 (ephemeral
  port), auto-creates CONTENT_ROOT, and seeds a welcome.md on an empty vault, so
  an MCP host (OpenClaw, Claude Desktop, Claude Code, Cursor) can spawn it with
  one `node dist/server.js` (npm bin `fsbrain-mcp`). Writes carry X-Actor:
  agent:mcp (override via MCP_ACTOR) and land in the human Activity feed;
  proposals await human approval in the Review tab.
```

Key facts an agent must know:

- **Storage is sandboxed** to `CONTENT_ROOT`. `PathResolver` rejects traversal
  and absolute paths. Do not weaken this.
- **Hidden dotfiles/dirs are excluded** from the tree. The audit log lives in
  `CONTENT_ROOT/.fsbrain/audit.jsonl`.
- **`@repo/shared` is consumed as source** (`main: src/index.ts`); it has no
  test runner — put its unit tests in `apps/api` (node vitest).
- **Optimistic concurrency** exists on writes via `etag` + `lastModified`
  (see `handlePutFile`). Reuse it for any new write path.
- **Provenance:** mutations read the `X-Actor` header (default `human`) and
  append an `AuditEntry`. Keep new write paths recording audit.
- API/MCP relative imports use explicit `.js` extensions (NodeNext). Match that.
  `npm run build` is green across all workspaces — keep it that way.

---

## 3. Current capabilities (grounded in code)

| Capability                                  | Status | Notes                                                                            |
| ------------------------------------------- | :----: | -------------------------------------------------------------------------------- |
| GitHub-style file tree + folders-first sort |   ✅   | `FileTreeSidebar`, `GlobalLayout`                                                |
| Create / rename / move / delete (md + dirs) |   ✅   | `/api/file`, `/api/dir`, `/api/path`                                             |
| Read / update with optimistic concurrency   |   ✅   | `etag` / `lastModified` in `handlePutFile`                                       |
| Edit ↔ Preview tabs                         |   ✅   | `FileViewerTabs`; hard toggle (not live WYSIWYG)                                 |
| Path sandboxing inside `CONTENT_ROOT`       |   ✅   | `PathResolver`                                                                   |
| Sidebar filter by **filename**              |   ✅   | `filterQuery` — name/path only, not file contents                                |
| "Fix Format" via OpenRouter                 |   ✅   | Client-side only (`openrouter/`)                                                 |
| `[[wikilinks]]` (clickable) + resolution    |   ✅   | `markdown.ts`, `remarkWikilinks`                                                 |
| Backlinks panel                             |   ✅   | `/api/backlinks`, `BacklinksPanel`                                               |
| Frontmatter + `#tags` parsing               |   ✅   | `@repo/shared` `markdown.ts`; chips in preview                                   |
| Rich renderer (GFM, math, highlight)        |   ✅   | `react-markdown` + remark-gfm/math, rehype-katex                                 |
| Full-text + tag search (Ctrl/Cmd-K)         |   ✅   | `/api/search`, `SearchDialog`                                                    |
| Semantic (relevance) search                 |   ✅   | `/api/semantic-search`, `semantic.ts` (TF-IDF)                                   |
| Hybrid retrieval (RRF fusion)               |   ✅   | `/api/hybrid-search`, `hybrid_search` tool, `hybrid.ts` (`reciprocalRankFusion`) |
| `think` (cited answers + offline gaps)      |   ✅   | `/api/think`, `think` tool, `think.ts` (`assembleAnswerKit`)                     |
| Dream-cycle maintenance → proposals         |   ✅   | `/api/maintenance[/scan]`, `run_maintenance`, `maintenance.ts` (`scanVault`)     |
| Outreach feedback loop → proposals          |   ✅   | `/api/feedback[/scan]`, `run_feedback`, `feedback.ts` (`scanFeedback`)           |
| Provenance / audit feed (Activity tab)      |   ✅   | `X-Actor`, `AuditLog`, `/api/audit`, `ActivityPanel`                             |
| Agent-edit review/approval queue            |   ✅   | `/api/proposals`, `ProposalStore`, `ReviewPanel`                                 |
| Granular agent writes (append/prepend/      |   ✅   | `PATCH /api/file`, `patch.ts`, `patch_note` MCP tool                             |
| section + idempotency + dry-run)            |        |                                                                                  |
| Block anchors (`^id`) + stable note ids     |   ✅   | `blocks.ts`, `noteId.ts`, `/api/block[-anchors]`                                 |
| Typed wikilinks (`[[T\|rel:supports]]`)     |   ✅   | `markdown.ts`, `Backlink.type`                                                   |
| Visual knowledge graph (Graph tab + API)    |   ✅   | `graph.ts`, `GET /api/graph`, `get_graph`, `GraphView`/`KnowledgeGraph`          |
| **MCP server** (agent tools)                |   ✅   | `apps/mcp` (25 tools) — writes as `agent:mcp`                                    |
| Self-contained MCP launch (embedded API)    |   ✅   | `npm run start:agent` → bin `fsbrain-mcp`, see CONNECT.md                        |
| Fresh-clone e2e MCP test (in `npm test`)    |   ✅   | `apps/mcp/src/__tests__/freshClone.test.ts`                                      |
| Live layer (SSE + file watcher)             |   ✅   | `events/` EventBus + `fs.watch`, `GET /api/events`, `useVaultEvents`             |
| Cached retrieval index (chunks+IDF, reused) |   ✅   | `index/vaultIndex.ts`, EventBus-invalidated; backs search + semantic             |
| Context bundles (token-budgeted RAG)        |   ✅   | `GET /api/context`, `get_context` tool, `context.ts` (pure packing)              |
| `npm run build` green (all workspaces)      |   ✅   | NodeNext `.js` imports + shared `rootDir`                                        |
| Retrieval eval harness (recall floors)      |   ✅   | `retrievalEval.ts`, fixture + `routes/retrievalEval.test.ts` (in `npm test`)     |
| CI (test + lint + build + format on PRs)    |   ✅   | `.github/workflows/ci.yml` — mirrors the local quality gate                      |
| Skill notes (procedural memory)             |   ✅   | `skills.ts`, `GET /api/skills`, `list_skills` tool; writes via proposals         |
| Question log (demand-driven gaps)           |   ✅   | `questions.ts`, `questions.jsonl`, `GET /api/questions`, `recent_questions`      |
| Review-queue learning (self-tuning)         |   ✅   | `proposalStats.ts`, `GET /api/proposals/stats`, `proposal_stats`; tunes the scan |
| Freshness scoring (stale + load-bearing)    |   ✅   | `maintenance.ts` `stale` kind (mtime + inbound links) → report-only finding      |

Legend: ✅ done · 🚧 in progress · ⬜ not started

---

## 4. Known gaps (the backlog, prioritized)

### For humans (vs Obsidian)

| Gap                                                | Priority | Status |
| -------------------------------------------------- | :------: | :----: |
| `[[wikilinks]]`, backlinks, link graph             |    P0    |   ✅   |
| Real CommonMark/GFM renderer (tables, images, task |    P0    |  ✅†   |
| lists, h3–h6, links, code highlight, math)         |          |        |
| Full-text **content** search + quick switcher      |    P1    |   ✅   |
| Frontmatter / tags / properties                    |    P1    |   ✅   |
| Non-markdown attachments (images, PDFs, canvas)    |    P2    |   ⬜   |
| Command palette, tabs/splits, outline, daily notes |    P2    |   ◑    |
| Version history / trash / Git sync                 |    P2    |   ⬜   |
| Plugin system, themes, mobile, multi-device sync   |    P3    |   ⬜   |

The link graph now has both backlinks and a **visual force-directed graph view**
(the Graph tab + `/api/graph`). ◑ = quick switcher + split done;
palette/outline/daily-notes open. † renderer shipped and lazy-loaded; Mermaid
diagrams are the remaining follow-up (see roadmap).

### For agents (the brain)

| Gap                                                  | Priority | Status |
| ---------------------------------------------------- | :------: | :----: |
| Machine-facing API / **MCP server** over the vault   |    P0    |   ✅   |
| **Provenance**: per-change attribution + audit feed  |    P0    |   ✅   |
| agent-edit review/approval queue                     |    P1    |   ✅   |
| Semantic retrieval (chunking + ranking; embeddings)  |    P1    |  ✅‡   |
| Structured knowledge (note IDs, block anchors `^id`, |    P1    |   ✅   |
| typed link graph)                                    |          |        |
| Section/append/patch writes + idempotency + dry-run  |    P1    |   ✅   |
| Live state (SSE/WebSocket + file watcher)            |    P2    |   ✅   |
| Cached search index (chunks+IDF, write-invalidated)  |    P2    |   ✅   |
| Context-bundle retrieval endpoint (token-budgeted)   |    P2    |   ✅   |
| Auth, per-agent scopes, path-level permissions       |    P2    |   ⬜   |

‡ chunking + TF-IDF cosine ranking shipped (`semantic.ts`, no API key, runs
offline); swapping in real vector embeddings via a provider is the follow-up.
Structured knowledge: Obsidian-style block anchors (`^id`), a frontmatter
`id:` for stable note identity (opt-in), and typed wikilinks
`[[Target|rel:type]]` all shipped together; the visual link graph view has now
shipped too (Graph tab + `GET /api/graph`).

---

## 5. Roadmap (sequenced slices)

Each slice is a vertical, demoable increment. Build in order — each unlocks the
next.

1. **Slice 1 — Links & metadata foundation.** ✅ Done.
   `markdown.ts` (frontmatter, `#tags`, `[[wikilink]]` parse + resolve),
   `GET /api/backlinks`, clickable wikilinks, backlinks panel.
2. **Slice 3 — Full-text + tag search.** ✅ Done.
   `GET /api/search` (text + tag), `search.ts` helper, Ctrl/Cmd-K `SearchDialog`
   (prefix `#` for tag search).
3. **Slice 4 — MCP server.** ✅ Done.
   `apps/mcp` stdio server exposing the vault as 16 tools. Self-contained: when
   `API_BASE_URL` is unset it starts the storage API in-process on
   `127.0.0.1` (ephemeral port), auto-creates `CONTENT_ROOT`
   (default `~/.fsbrain/vault`), and seeds a `welcome.md` on first run.
   Bundled to a single-file bin via esbuild (`fsbrain-mcp` →
   `apps/mcp/dist/server.js`) so an MCP host can spawn it with one
   `node dist/server.js`. Writes carry `X-Actor: agent:mcp` (override via
   `MCP_ACTOR`) and flow through the audit trail. Copy-paste host configs
   for OpenClaw / Claude Desktop / Claude Code / Cursor:
   [`CONNECT.md`](CONNECT.md). The clone-and-run guarantee is enforced by
   `apps/mcp/src/__tests__/freshClone.test.ts`, which spawns the bin as a
   real stdio child against a temp vault and asserts writes land on disk
   and in the audit log — runs in `npm test`.
4. **Slice 6a — Provenance.** ✅ Done.
   `X-Actor` attribution, append-only `AuditLog` (`.fsbrain/audit.jsonl`),
   `GET /api/audit`, and the human-facing **Activity** tab.
5. **Slice 2 — Real renderer.** ✅ Done.
   `MarkdownPreviewPane` uses `react-markdown` + `remark-gfm` (tables, task
   lists, strikethrough, autolinks, h3–h6), `remark-math` + `rehype-katex`
   (math), and highlight.js for fenced code (keeping the copy button). The
   `remarkWikilinks` plugin preserves `[[wikilinks]]`; frontmatter is stripped
   and tags render as chips. The pane is lazy-loaded (`React.lazy`), so the main
   bundle stays ~63 kB gzip and the renderer (~186 kB gzip) loads on demand.
6. **Slice 5 — Semantic search.** ✅ Done (local).
   `semantic.ts` chunks notes and ranks them by TF-IDF cosine similarity;
   `GET /api/semantic-search`, a Text|Semantic toggle in `SearchDialog`, and a
   `semantic_search` MCP tool. Runs offline, no API key. A real embedding
   provider can replace the ranking engine without changing callers.
7. **Slice 6b — Agent-edit review queue.** ✅ Done.
   Agents `propose_edit` (`POST /api/proposals`) create/update/delete edits;
   `ProposalStore` keeps them in `.fsbrain/proposals/`. A human reviews the diff
   in the **Review** tab and approves (applied + audited as the proposer) or
   rejects. Resolution is human-only. Closes the provenance trust loop.
8. **Slice 7 — Granular agent writes.** ✅ Done.
   `PATCH /api/file` (and the `patch_note` MCP tool) apply `append`,
   `prepend`, or `replace_section` ops without rewriting the whole note.
   Pure transforms live in `@repo/shared` (`patch.ts`). The endpoint reuses
   the `etag` optimistic-concurrency contract, accepts an `idempotencyKey`
   so a retried patch is a no-op (in-memory LRU cache; resets on API
   restart), supports `dryRun` to preview without writing or auditing, and
   records audit attribution via `X-Actor`.
9. **Slice 8 — Structured knowledge.** ✅ Done.
   Obsidian-style **block anchors** (`^id`) give agents stable addresses
   inside a note. Pure helpers live in `@repo/shared` (`blocks.ts`):
   `extractBlockAnchors`, `findBlock` (paragraph / list-item /
   heading-section), `upsertBlockAnchor`. `GET /api/block` returns a block
   - surrounding context; `GET /api/block-anchors` lists every anchor.
     `PATCH /api/file` gains a `replace_block` op (anchor re-attached so the
     block stays addressable) and an `ensure_id` op (adds frontmatter `id:`
     if missing — idempotent). `/api/file` and the patch endpoint accept
     `id=` as an alternative to `path=`. Wikilink parsing recognizes
     `[[Target|rel:supports]]` and `/api/backlinks` surfaces the relation
     (`type`). The MCP server adds `read_block` and `get_block_anchors`, and
     `patch_note` exposes `replace_block` / `ensure_id`. The preview
     unobtrusively renders trailing `^id` markers; everything else stays the
     same. Provenance is preserved — block writes audit under the requesting
     actor like any other PATCH.

### Prioritization

This is a **local, single-user tool optimized for agent interaction on the
owner's machine** — not a multi-user / externally-exposed service. So the
priorities are **agent depth** plus a **visual graph** for the human. Multi-user
concerns (authn/z, per-agent scopes, rate limiting), CI, attachments, editor
polish, mobile, and multi-device sync are **explicitly deprioritized** for now.

10. **Slice 9 — Live layer.** ✅ Done.
    An in-process `EventBus` (`apps/api/src/events/eventBus.ts`) receives a
    `VaultEvent` (`@repo/shared`) from every mutating handler, published beside
    the audit write so the live stream and the audit log never diverge. A
    recursive `fs.watch` watcher (`watcher.ts`, ~150ms debounce) publishes
    `source:'watch'` events for out-of-band edits, ignoring `.fsbrain/` and
    non-`.md` churn and de-duping against API writes within a short window.
    `GET /api/events` (`sse.ts`) streams events over SSE with heartbeats and
    disconnect cleanup. The web `useVaultEvents` hook subscribes via
    `EventSource`, auto-reconnects, and surgically refreshes the tree, the open
    file (preserving unsaved drafts — a "changed on disk" prompt rather than a
    clobber), the Activity feed, and the Review badge; a live/reconnecting
    indicator sits in the layout. The MCP server's embedded API starts the bus
    - watcher too. Covered by `apps/api/src/routes/events.test.ts` (SSE +
      watcher + `.fsbrain` exclusion) and
      `apps/web/src/hooks/__tests__/useVaultEvents.test.ts`.

11. **Slice 10 — RAG: cached index + context bundles.** ✅ Done.
    An in-memory `VaultIndex` (`apps/api/src/index/vaultIndex.ts`) chunks every
    note and computes the IDF + per-chunk TF-IDF vectors once (shared
    `buildSemanticIndex` / `queryRankedChunks` in `semantic.ts`), reusing them
    across queries. It subscribes to the live-layer `EventBus`, so any
    create/update/move/delete (API or watcher) invalidates it; the next query
    lazily rebuilds from disk, reusing the cached content of unchanged notes, and
    never serves stale results after a write. Both `/api/search` and
    `/api/semantic-search` read through it; ranking is unchanged (verified by the
    pre-existing `semantic.test.ts` / `searchAudit.test.ts`). `GET /api/context`
    (and the `get_context` MCP tool, 17th tool) assembles a token-budgeted
    bundle — top query-ranked passages (`kind:"match"`) plus, for a focus
    `path`, that note + its backlinks (`kind:"neighbor"`) — de-duped and packed
    within the budget (`ceil(chars/4)`, no tokenizer dep). The shaping helpers
    are pure + tested in `@repo/shared` (`context.ts`); covered by
    `apps/api/src/__tests__/context.test.ts` (packing/de-dupe/truncation) and
    `apps/api/src/routes/context.test.ts` (relevance, 422, no-stale-after-write).
    Fully local/offline; the ranking engine stays swappable for real embeddings.

12. **Slice 11 — Visual knowledge graph.** ✅ Done. **Completes the planned
    roadmap.** A pure `buildGraph` (`@repo/shared` `graph.ts`) turns the note
    corpus into `GraphData` (`{ nodes: { id, label, tags, unresolved? }, edges:
{ source, target, type? } }`) using the same `extractWikilinks` +
    `resolveWikilink` as `/api/backlinks`. Unresolved link targets become
    distinct placeholder nodes (`unresolved: true`); a typed `[[Target|rel:type]]`
    relation rides on the edge; self-links and duplicate edges are dropped.
    `GET /api/graph` (and the `get_graph` MCP tool, 18th tool) serves it from the
    cached `VaultIndex` — no per-call vault re-read, `.fsbrain/` excluded,
    read-only (no `VaultEvent`). The web **Graph** tab renders a dependency-free,
    force-directed SVG (`apps/web` `KnowledgeGraph`, lazy-loaded; deterministic
    Fruchterman–Reingold layout in `graphLayout.ts`): click a node to open the
    note, hover to highlight a node + its neighbors, unresolved nodes styled with
    the `wikilink--unresolved` palette, optional tag colouring, pan/zoom — and it
    live-refreshes (debounced) off the existing `/api/events` stream. Covered by
    `apps/api` `graph.test.ts` (builder) + `routes/graph.test.ts` (endpoint,
    unresolved placeholder, no-stale-after-write) and `apps/web`
    `GraphView.test.tsx` (renders nodes from `/api/graph`, click opens a note).

### Next up (open, in priority order)

The planned roadmap is complete. The remaining items are optional enhancements,
not part of the original plan:

13. **Real embeddings** (the remaining half of RAG). Swap the TF-IDF ranker for
    vector embeddings (remote `/v1/embeddings` or on-device) behind the existing
    `documents → ranked` seam — `buildSemanticIndex` / `queryRankedChunks` and
    the `VaultIndex` cache already isolate callers from the engine, and the
    context-bundle endpoint consumes ranked chunks regardless of how they were
    scored. Persist the index across restarts as a follow-on.
14. **Mermaid diagrams** — render fenced ` ```mermaid ` blocks in the preview
    (the last renderer follow-up; the wikilink graph view above is done).

#### Brain ideas (inspired by gbrain)

A backlog of enhancements adapted from [gbrain](https://github.com/garrytan/gbrain),
an AI-agent memory system, but cut to fit this repo's design constraints
(**local-first, offline, no API key, pure + deterministic helpers in
`@repo/shared`, every agent write audited**). Listed in build order; each plugs
into infrastructure we already have rather than adding a new subsystem.

15. **Hybrid retrieval (RRF).** ✅ **Done.** Fuse the existing lexical
    (`search.ts`) and semantic (`semantic.ts`) rankings with Reciprocal Rank
    Fusion so neither exact keyword hits nor conceptually-related passages are
    missed. Pure fusion helper in `@repo/shared` (`hybrid.ts` —
    `reciprocalRankFusion`, `HybridHit`); `GET /api/hybrid-search` + the
    `hybrid_search` MCP tool + a **Hybrid** mode in the Ctrl/Cmd-K switcher. Both
    engines read through the cached `VaultIndex`. Tests: `apps/api`
    `__tests__/hybrid.test.ts` (pure RRF) and `routes/hybridSearch.test.ts`
    (endpoint). _gbrain parallel: its biggest measured win came from fusing
    vector + keyword + RRF rather than vector-only retrieval._
16. **`think` — synthesized, cited answers + gap analysis.** ✅ **Done.** Builds
    on hybrid retrieval + the token-budgeted context bundle to return a **cited
    answer kit**: numbered citations (`[1]`, `[2]`…) mapped to each source passage
    (path + heading + `^block` anchor), the passages, and a deterministic,
    **offline gap analysis** (`weakCoverage` + `uncoveredTerms` — "what the vault
    doesn't yet cover"), all computed with **no model**. Pure helper in
    `@repo/shared` (`think.ts` — `assembleAnswerKit`); `GET /api/think` + the
    `think` MCP tool. Offline by default — the calling agent is the LLM and
    composes the final answer from the kit; a server-side `OPENROUTER_API_KEY`
    plus `?synthesize=1` optionally adds a synthesized prose `answer`. Tests:
    `apps/api` `__tests__/think.test.ts` (pure) + `routes/think.test.ts`
    (endpoint). _gbrain parallel: `gbrain think` — "search gives raw pages, the
    brain gives the answer," with built-in gap analysis._
17. **Dream-cycle maintenance → proposals.** ✅ **Done.** A scan
    (`@repo/shared` `maintenance.ts` — `scanVault`) flags **broken
    `[[wikilinks]]`**, **orphan notes**, **near-duplicate notes** (note-level
    TF-IDF cosine ≥ threshold), and **stale-but-load-bearing notes** (added later
    as freshness scoring #5 — heavily linked yet unchanged for > 90 days,
    report-only), then files each actionable one as a **proposal** a
    human approves in the Review tab — reusing the `ProposalStore` + `EventBus`,
    no new subsystem. Each finding carries a safe, reversible suggestion that maps
    1:1 onto a proposal (broken link → `create` a stub; duplicate → `update`
    appending a `> See also [[other]]` cross-link, never a merge; orphan and
    stale are report-only). The duplicate threshold **self-tunes** from the
    review queue's approve/reject history (review-queue learning #2). `GET /api/maintenance` previews (files nothing);
    `POST /api/maintenance/scan` + the `run_maintenance` MCP tool file each
    suggestion as `agent:maintenance`, **deduped against pending + rejected
    proposals** so re-runs are idempotent and never re-surface a declined fix; an
    `update` (cross-link) carries the target's `baseEtag` so a stale approval
    `409`s. On-demand by default;
    optional `MAINTENANCE_INTERVAL_MS` timer in `createServer`. Resolution stays
    **human-only**. A light Maintenance action sits atop the web Review tab.
    **Contradiction detection is deferred** (it needs an LLM, which breaks the
    offline guarantee) behind the same `OPENROUTER_API_KEY` gate as `think`
    synthesis. Tests: `apps/api` `__tests__/maintenance.test.ts` (pure) +
    `routes/maintenance.test.ts` (endpoint). _gbrain parallel: its 24/7 "dream
    cycle" that dedupes, fixes citations, and finds contradictions overnight._
18. **Self-wiring typed graph edges.** ✅ **Done.** The knowledge graph now
    derives typed edges from frontmatter: **any frontmatter field whose value
    contains a `[[wikilink]]`** becomes a typed edge with the **field name as the
    relation type** — so `related: [[Foo]]` wires a `related` edge with no manual
    `[[Foo|rel:related]]` discipline in the body. The presence of `[[...]]` is
    the signal, so plain scalar metadata (`type: person`, `tags: [a, b]`) is
    skipped without a reserved-key list; a link that carries its own `rel:` type
    keeps it, overriding the field name. Both inline
    (`related: [[Foo]], [[Bar]]`) and YAML block-list forms are recognised.
    Shipped as pure helpers in `@repo/shared` `graph.ts`
    (`extractFrontmatterRelations`; `buildGraph` gains a `frontmatterRelations`
    option, default on — `false` restores body-only edges). No new write path or
    endpoint: `GET /api/graph` + the `get_graph` MCP tool serve the richer edges
    from the same cached `VaultIndex`. `buildGraph` now scans the body with the
    frontmatter stripped so a relation field isn't double-counted as a plain
    body link. Tests: `apps/api` `__tests__/graph.test.ts` (pure: field-name
    types, inline arrays, block lists, unresolved targets, `rel:` precedence,
    opt-out) + `routes/graph.test.ts` (endpoint self-wiring). _gbrain parallel:
    typed edges (`works_at`, `attended`) auto-extracted on write, zero LLM
    calls._
19. **Schema packs / typed page types.** Canonical frontmatter `type:` values
    (person, meeting, idea…) with allowed relationships — powers graph node
    colouring, validation, and retrieval boosting. _gbrain parallel:
    `gbrain-base-v2` with 15 canonical types._
20. **Retrieval eval harness.** ✅ **Done.** A golden fixture of
    `query → expected-note` pairs (`apps/api`
    `__tests__/fixtures/retrievalCorpus.ts` — 12 notes, 9 judged queries
    covering exact phrases, filename-only hits, paraphrases, and stemming) is
    run against the three **real** ranking stacks — `/api/search`,
    `/api/semantic-search`, `/api/hybrid-search` — through a live server +
    cached `VaultIndex` (`routes/retrievalEval.test.ts`), with per-engine
    recall floors pinned just below measured scores (lexical ≥ 0.4, measured
    0.44; semantic ≥ 0.85, measured 0.89; **hybrid must retrieve every
    expected note**, and must be ≥ either engine alone). The metric side is
    pure in `@repo/shared` (`retrievalEval.ts` — `scoreEvalCase`,
    `summarizeEval`, `formatEvalReport`: recall@k + MRR@k over a de-duplicated
    top-k). Runs in `npm test`, so a ranking change (tokenizer, chunking, or a
    future embedding engine behind the same seam — item #13) cannot silently
    regress recall; a broken floor prints the exact failing queries. _gbrain
    parallel: its LongMemEval / NamedThingBench regression suite._

21. **Skill notes — procedural memory.** ✅ **Done.** A frontmatter convention
    (`type: skill`, optional `name:` / `description:`) marks a note as a
    reusable playbook; `@repo/shared` `skills.ts` (`parseSkill`, `listSkills`)
    summarizes them, `GET /api/skills?q=...` + the `list_skills` MCP tool
    (22nd) list them from the cached `VaultIndex`. No new write path: read via
    `read_note`, contribute via `propose_edit` (human-approved), with the tool
    description nudging the agent to consult skills before a task and distill
    new ones after — the first self-improvement loop from
    [`improvement-ideas.md`](improvement-ideas.md). Tests: `apps/api`
    `__tests__/skills.test.ts` (pure) + `routes/skills.test.ts` (endpoint).
22. **Question log — demand-driven gaps.** ✅ **Done.** Every `think` query is
    persisted with its gap signal (`weakCoverage` + `uncoveredTerms`, actor
    from `X-Actor`) to `.fsbrain/questions.jsonl` (`QuestionLog`, mirroring
    `AuditLog`; best-effort — never fails the answer). Pure
    `findKnowledgeGaps` (`@repo/shared` `questions.ts`) distills recurring
    uncovered terms (≥ `minCount` questions, repeats count as demand);
    `GET /api/questions` + the `recent_questions` MCP tool (23rd) return
    `{ entries, gaps }`, with the tool description nudging the agent to
    `propose_edit` notes that fill recurring gaps — the second
    self-improvement loop from [`improvement-ideas.md`](improvement-ideas.md)
    (#3). Tests: `apps/api` `__tests__/questions.test.ts` (pure) +
    `routes/questions.test.ts` (endpoint).

A broader brainstorm of follow-on **self-improvement loops** (skill notes,
review-queue tuning, a question log, implicit relevance feedback, freshness
scoring) lives in [`improvement-ideas.md`](improvement-ideas.md) — skill notes
(#1), the question log (#3), review-queue tuning (#2), and freshness scoring
(#5) have shipped; implicit relevance feedback (#4) remains.

Deferred (not a priority for the local/agent focus): authn/z + per-agent scopes,
non-markdown attachments, editor ergonomics (palette/outline/daily
notes/WYSIWYG), version history/Git sync, plugins/themes/mobile/sync. Proposal
follow-ups also deferred: settled-proposal retention/pruning, a computed
line-level diff in the Review UI, and closing the no-`baseEtag` update TOCTOU.
Likewise deferred: rotation/pruning for the append-only `.fsbrain` logs
(`audit.jsonl`, `questions.jsonl`) — both are re-read whole per request, fine
for a personal vault but worth bounding once they grow.

The vault is now natively an agent's brain _and_ auditable by the human, and the
human can finally _see_ how it all connects via the graph — completing the
planned roadmap. The optional items above deepen it further.

---

## 6. Conventions for contributors (human or agent)

- **Read [`AGENTS.md`](../AGENTS.md) first.** Follow the Operating Rules and
  Claude Code Rules there.
- Keep changes **surgical**; match the file's existing style.
- Preserve the **path-sandboxing** and **markdown-only** safety guarantees.
- Add tests next to the code they cover (`*.test.ts(x)`); shared utils →
  `apps/api`.
- Verify with project commands (§7). Do not invent commands.
- **Update this file** when a slice's status changes.

---

## 7. Commands

```bash
npm install          # install workspaces
npm run dev:api      # API   → http://localhost:3001
npm run dev:web      # web   → http://localhost:5173
npm run start:agent  # self-contained MCP server on stdio (fsbrain-mcp)
npm run doctor       # preflight: Node version + vault writable
npm test             # all workspace tests (vitest), incl. fresh-clone MCP e2e
npm run lint         # eslint
npm run build        # tsc/vite/esbuild build across workspaces (produces the MCP bin)
```
