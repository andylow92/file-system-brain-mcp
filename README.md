<p align="center">
  <img src="apps/web/public/logo.svg" alt="fsbrain — AI-native markdown vault" width="520" />
</p>

<p align="center">
  <strong>Own the context. Rent the memory.</strong><br />
  <em>Your notes stay plain <code>.md</code> files you own — bring any AI model and swap it whenever you like.</em>
</p>

# fsbrain — an AI-native markdown vault (MCP server + second brain)

> **A local-first markdown vault you can hand to an AI agent — and it gets better
> the more you use it.** Browse it like a **GitHub file tree**, edit it like
> **Notion**, and plug it into Claude, Cursor, or any **MCP** host as **25 agent
> tools** — semantic & hybrid search, RAG context, and cited answers. The vault
> **self-improves**: it learns your writing voice from your draft→final edits and
> self-tidies broken links, orphans, and duplicates — every change lands in a
> **human-in-the-loop review queue** where agents propose and you decide. Plain
> `.md` files, runs offline, no API key required.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](#)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=000)](#)
[![Node.js](https://img.shields.io/badge/Node.js-22.x-339933?logo=node.js&logoColor=white)](#)
[![Vite](https://img.shields.io/badge/Vite-5.x-646CFF?logo=vite&logoColor=white)](#)

If you’ve ever wanted your markdown content to be:

- **easy to navigate** like a repo,
- **easy to edit** like a modern docs tool,
- and **stored as real files** (not locked in a database),

this project is for you.

---

## Why this project exists

Most note/documentation tools force a tradeoff:

- Great UX, but proprietary storage.
- Great storage (plain files), but clunky UX.

This repo bridges both worlds:

- ✅ Familiar tree-based navigation
- ✅ Markdown-first editing and preview
- ✅ Safe filesystem-backed API
- ✅ Monorepo structure for easy extension

---

## What you can do with it

- Browse markdown content in a GitHub-like file tree
- Open files and switch between **Preview** and **Edit** tabs
- Create, rename/move, and delete files and folders
- Save with optimistic concurrency metadata (`etag` / `lastModified`)
- Keep your content under a configurable `CONTENT_ROOT` (the "vault")
- Search across notes — **full-text**, **semantic**, and **hybrid** (Ctrl/Cmd-K)
- Link notes with `[[wikilinks]]`, browse **backlinks**, and explore an
  interactive **knowledge graph**
- Hand the vault to an AI agent through a built-in **MCP server**
  (read / search / patch / propose), with every agent write attributed in an
  audit log so the human can see what changed

---

## 🤖 AI & agent features

This isn't just a file browser — the vault is built to double as **an AI agent's
brain**, with a human always in control. Everything below runs **locally and
offline by default** (no API key needed), and anything an agent wants to change
in your notes goes through a **review queue you approve**.

- **🔎 Smart search.** Find notes by **meaning**, not just exact words —
  `semantic` search ranks by relevance and `hybrid` search fuses keyword +
  semantic results. Great for _"I know I wrote this somewhere…"_. Runs offline
  on a built-in TF-IDF ranker by default; flip on **real embeddings** (below)
  when you want stronger synonym/paraphrase matching.
- **💬 Ask your notes (`think`).** Ask a question and get a **cited answer**
  assembled from your own notes — plus an honest list of **gaps** when the vault
  can't fully answer, so you know what's missing.
- **🔌 Plug in any AI agent (MCP).** A built-in
  [MCP](https://modelcontextprotocol.io) server hands the whole vault to agents
  like Claude, Cursor, or OpenClaw as **26 tools** (read, search, patch,
  propose…). **Every agent write is logged** to an audit trail, and edits land as
  **proposals you approve** — the agent suggests, only you commit.
- **🧹 Self-tidying vault (maintenance).** A "dream-cycle" scan finds **broken
  links, orphaned notes, near-duplicates, stale-but-load-bearing notes**
  (heavily linked yet long unchanged — "is this still accurate?"), **and schema
  issues** (a note typed wrong, or a relation pointing at the wrong kind of note)
  and files each fix as a proposal. Re-running is safe — it never spams your
  review queue, and it **learns your taste**: the duplicate-detection bar
  self-tunes from which proposals you approve vs. reject.
- **🏷️ NEW — Typed notes (schema packs).** Give a note a `type:` (person,
  meeting, project, idea…) and the graph **colours it by what it is**, agents
  learn the canonical types to author well-formed notes, and the maintenance scan
  flags notes that break the vocabulary — all from plain frontmatter, no database.
- **🧠 NEW — Real embeddings (opt-in).** Semantic search is TF-IDF by default —
  fully offline, no key. Set `FSBRAIN_EMBEDDINGS=on` with an API key and the same
  search routes rank by **dense vector similarity** instead, so paraphrases and
  synonyms that share no keywords still match. It's a **drop-in swap**: nothing
  downstream (`semantic`/`hybrid` search, `think`, RAG context) changes, only the
  scoring improves. Vectors are **cached to `.fsbrain/embeddings.json`** so a
  restart re-embeds only changed notes, and the engine **falls back to TF-IDF**
  on any provider outage — "off" is always a working search. See the
  `FSBRAIN_EMBEDDINGS` env vars below.
- **🪄 NEW — Learns from your edits (feedback loop).** When an agent drafts
  outreach — an **X post, LinkedIn message, or email** — and you rewrite it
  before sending, that edit is valuable signal. A scan compares the **draft vs.
  your final version**, distills _what you changed (and why)_ into a reusable
  **playbook lesson**, and files it as a proposal. Over time the vault writes
  more like _you_. **Nothing is ever auto-posted or sent** — it only proposes
  notes for your review.

> **The throughline: agents propose, you decide.** Risky or outward-facing
> changes are never applied automatically — they become reviewable proposals
> attributed to a named actor (e.g. `agent:maintenance`, `agent:feedback-loop`),
> so you always see who suggested what.

**The feedback loop in 30 seconds:**

1. An agent drafts a post at `social/x/drafts/launch.md`.
2. You edit it and save what you actually shipped to `social/x/old-posts/launch.md`.
3. You add a tiny "pairing" note linking the two (frontmatter: `type: feedback`,
   `channel: x`, `draftPath`, `finalPath`, and an optional `reviewReason`).
4. Run the `run_feedback` agent tool (or `POST /api/feedback/scan`). It compares
   the two, distills the lesson into a channel **playbook**, and files it as a
   **proposal** you approve in the Review tab.

---

## Built for real-world use cases

- Personal knowledge management (PKM)
- Team docs portals
- Internal runbooks/playbooks
- Product/project documentation
- Lightweight markdown CMS foundations

---

## Architecture at a glance

```txt
apps/web (React + Vite)
   ├─ File tree + editor / preview / graph / activity UI
   └─ Calls the API over HTTP/JSON (live updates over SSE)

apps/api (Node HTTP server)
   ├─ Validates and resolves logical paths (sandboxed to CONTENT_ROOT)
   ├─ Markdown-focused file CRUD + optimistic concurrency
   └─ Search (text/semantic/hybrid), backlinks, graph, think, audit, proposals

apps/mcp (MCP stdio server)
   ├─ Exposes the vault to AI agents as 26 tools
   └─ Embeds the API in-process — one self-contained command for an MCP host

packages/shared
   └─ Shared TypeScript contracts + pure helpers (markdown, search, graph, …)
```

Repository structure:

```txt
apps/
  api/      # Backend HTTP server + filesystem storage (CONTENT_ROOT)
  web/      # Frontend UI (React + Vite)
  mcp/      # MCP stdio server — the vault as agent tools (embeds the API)
packages/
  shared/   # Shared types/contracts + pure helpers
docs/
  implementation.md         # Source of truth for project state
  CONNECT.md                # Connect an MCP host (OpenClaw / Claude / Cursor)
  integration-test-plan.md  # Manual integration checks
AGENTS.md   # Start here if you are an AI agent working in this repo
```

---

## Quick start (under 5 minutes)

### 1) Prerequisites

- Node.js **22.x**
- npm **10.x**

### 2) Install

```bash
npm install
```

### 3) Run API + Web (two terminals)

Terminal A:

```bash
npm run dev:api
```

Terminal B:

```bash
npm run dev:web
```

### 4) Open the app

- Web UI: `http://localhost:5173`
- API health: `http://localhost:3001/health`

---

## Use it as an agent's brain (clone & run)

Skip the web UI and hand the vault to an MCP-aware agent (OpenClaw, Claude
Desktop, Claude Code, Cursor, …):

```bash
git clone https://github.com/andylow92/file-system-like-github.git
cd file-system-like-github
npm install
npm run build            # produces apps/mcp/dist/server.js
npm run start:agent      # launches the self-contained fsbrain-mcp on stdio
```

`fsbrain-mcp` embeds the storage API in-process and auto-creates the vault
at `~/.fsbrain/vault` (override with `CONTENT_ROOT=...`). It exposes 25
vault tools (`list_notes`, `read_note`, `create_note`, `patch_note`,
`semantic_search`, `hybrid_search`, `think`, `get_graph`, `propose_edit`,
`run_maintenance`, `list_skills`, `run_feedback`, `proposal_stats`, …) and records every agent write to
`<vault>/.fsbrain/audit.jsonl` so you can always see what the agent did.

**Copy-paste config snippets** for OpenClaw / Claude Desktop / Claude Code
/ Cursor are in **[`docs/CONNECT.md`](docs/CONNECT.md)**.

> **Heads-up if you have an older clone.** The default `CONTENT_ROOT` is now
> `~/.fsbrain/vault` (previously `<cwd>/content`). Existing `./content`
> notes aren't deleted, but `npm run dev:api` / `npm run dev:web` /
> `npm run start:agent` without `CONTENT_ROOT` set will now read the new
> path. Set `CONTENT_ROOT=./content` (in `apps/api/.env` or your shell) to
> keep the old location.

---

## Environment variables

For `apps/api`:

- `CONTENT_ROOT`
  - Base directory (the "vault") for markdown files/directories.
  - If unset, defaults to `~/.fsbrain/vault` (auto-created on first run).
  - Set `CONTENT_ROOT=./content` to keep an older clone's location.
- `PORT`
  - API server port (default: `3001`).
- `FSBRAIN_EMBEDDINGS`
  - Opt-in switch for the **embedding** retrieval engine. Off by default
    (`1`/`true`/`on`/`yes` turns it on); when off, semantic search uses the
    fully-offline TF-IDF engine — no network, no key, exactly as before.
  - When on, needs a key: `EMBEDDINGS_API_KEY` (falls back to
    `OPENROUTER_API_KEY`). If the provider is unreachable or misconfigured,
    retrieval automatically falls back to TF-IDF, so "off" is always a working
    search — flip the flag off and restart to revert entirely.
  - Optional overrides: `EMBEDDINGS_MODEL` (default
    `openai/text-embedding-3-small`), `EMBEDDINGS_URL` (any OpenAI-compatible
    `/v1/embeddings` endpoint; default OpenRouter), `EMBEDDINGS_BATCH_SIZE`
    (default `96`).
  - Vectors are cached to `<CONTENT_ROOT>/.fsbrain/embeddings.json` so a restart
    re-embeds only changed notes. The file is safe to delete (it rebuilds on
    demand) and is tagged with the model, so switching `EMBEDDINGS_MODEL`
    invalidates it automatically.

Example:

```bash
CONTENT_ROOT=/absolute/path/to/vault PORT=3001 npm run dev:api

# Opt into embedding-based semantic search:
FSBRAIN_EMBEDDINGS=on EMBEDDINGS_API_KEY=sk-... npm run dev:api
```

---

## API snapshot

**Files & tree**

- `GET /health`
- `GET /api/tree?path=...`
- `GET /api/file?path=...` (or `?id=...`)
- `POST /api/file` · `PUT /api/file` · `PATCH /api/file` (granular ops)
- `POST /api/dir`
- `PATCH /api/path` (move/rename) · `DELETE /api/path?path=...&recursive=true|false`

**Links, graph & blocks**

- `GET /api/backlinks` · `GET /api/graph`
- `GET /api/block` · `GET /api/block-anchors`

**Search & retrieval**

- `GET /api/search` · `GET /api/semantic-search` · `GET /api/hybrid-search`
- `GET /api/context` (RAG bundle) · `GET /api/think` (cited answer kit)

**Provenance, review & maintenance**

- `GET /api/audit`
- `GET /api/proposals` · `POST /api/proposals` · `POST /api/proposals/resolve` (human-only)
- `GET /api/proposals/stats` (review-queue approval rates + threshold nudges)
- `GET /api/maintenance` · `POST /api/maintenance/scan`
- `GET /api/feedback` · `POST /api/feedback/scan`

**Live**

- `GET /api/events` (Server-Sent Events)

For endpoint details and request/response examples, see [`apps/api/README.md`](apps/api/README.md).
Agents typically reach these via the MCP tools — see [`apps/mcp/README.md`](apps/mcp/README.md).

---

## Local quality checks

```bash
npm test
npm run lint
npm run format
```

---

## Security model (important)

- API path handling rejects traversal and absolute paths.
- File operations are markdown-focused (`.md`).
- Storage resolution ensures requests remain within `CONTENT_ROOT`.

This helps protect the host filesystem while still enabling file-based workflows.

---

## Deployment note

For persistent content in production, mount a host volume and point `CONTENT_ROOT` to it.

See the full deployment examples in this README’s history and backend docs.

---

## Roadmap ideas

- ✅ Search across markdown files (full-text, semantic, and **hybrid** RRF)
- ✅ Interactive knowledge graph + backlinks
- ✅ Built-in MCP server — use the vault as an agent's brain
- ✅ Cited answers + offline gap analysis (`think`) and dream-cycle maintenance
- ✅ Self-improving outreach **feedback loop** — learns your voice from draft→final edits
- ✅ Typed page types / **schema packs** — canonical `type:`s, graph colouring, validation
- ✅ Mermaid diagrams — fenced ` ```mermaid ` blocks render as SVG in the preview
- Real vector embeddings (the cached index is the seam)
- Git sync workflows
- Multi-user auth + permissions
- Real-time collaborative editing
- Pluggable storage adapters

---

## Contributing

PRs are welcome. If you want to contribute:

1. Open an issue with the use case/problem statement.
2. Submit a focused PR with tests.
3. Keep markdown/file safety guarantees intact.

---

## Extra docs

- **AI agents start here:** [`AGENTS.md`](AGENTS.md) — repo entry point + a
  tool/endpoint quick-reference
- Project state / roadmap (source of truth): [`docs/implementation.md`](docs/implementation.md)
- Backend API details: [`apps/api/README.md`](apps/api/README.md)
- Agent tools (MCP) + write attribution: [`apps/mcp/README.md`](apps/mcp/README.md)
- Connect an MCP host (OpenClaw / Claude / Cursor): [`docs/CONNECT.md`](docs/CONNECT.md)
- Manual integration validation: [`docs/integration-test-plan.md`](docs/integration-test-plan.md)

---

## Keywords (for discoverability)

**AI-native:** MCP server, Model Context Protocol, AI agent tools, agent memory,
self-improving knowledge base, learns-from-edits feedback loop, self-healing
maintenance, agentic RAG, retrieval-augmented generation, semantic search, hybrid
search (RRF), vector-ready knowledge base, Claude / Cursor / OpenClaw integration,
second brain for LLMs, human-in-the-loop, agent proposals & audit log, cited answers.

**Markdown workspace:** github-like file tree, notion-style markdown editor,
local-first markdown vault, filesystem CMS, markdown knowledge base, wikilinks &
backlinks, knowledge graph, react markdown editor, node filesystem api, PKM.
