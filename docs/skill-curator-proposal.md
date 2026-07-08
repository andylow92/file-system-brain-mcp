# Design proposal — a "skill curator": usage-aware skill lifecycle

> **Status: proposal (no code yet), for maintainer review.**
> Captured 2026-07. Complements the self-improvement brainstorm in
> [`improvement-ideas.md`](improvement-ideas.md) (this is item **#6**) and the
> backlog in [`implementation.md`](implementation.md). Inspired by the
> **Curator** in [Nous Research's Hermes Agent](https://github.com/nousresearch/hermes-agent).

## 1. Motivation

Hermes Agent markets a "closed learning loop": the agent **creates skills from
experience, improves them during use, and prunes them so they don't pile up**.
The pruning half is the **Curator** — a background pass that tracks per-skill
_usage telemetry_ (`use_count`, `view_count`, `patch_count`, `last_used_at`),
moves unused skills through `active → stale → archived`, and (optionally)
consolidates near-duplicate skills into umbrellas. It never auto-deletes; the
worst case is a recoverable archive.

fsbrain already has **most of Hermes' loop** (see §2). The one piece it lacks is
exactly the Curator's core: **skills have no lifecycle and no usage signal**, so
a stale or redundant skill note sits in the catalog forever, quietly costing
tokens and diluting `list_skills`. This proposal adds a fsbrain-idiomatic,
offline, human-gated "skill curator" to close that gap.

## 2. What fsbrain already has (Hermes → fsbrain map)

| Hermes concept                                     | fsbrain today                                                                  | Status                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Skills = `SKILL.md` knowledge docs                 | Skill notes (`type: skill`), `@repo/shared` `skills.ts`                        | ✅                                                                  |
| Progressive disclosure (list → view → ref)         | `list_skills` (L0) + `read_note` (L1)                                          | ✅                                                                  |
| Autonomous skill creation, **write-approval gate** | Agent `propose_edit` → human approves in Review tab                            | ✅                                                                  |
| Skill self-improvement during use                  | Outreach feedback loop → channel playbook (a `type: skill` note); `patch_note` | ✅ (partial)                                                        |
| Curator: **consolidate near-duplicates**           | Maintenance `duplicate` finding (generic, note-level cosine)                   | ⚠️ not skill-aware                                                  |
| Curator: **stale → archive by non-use**            | Maintenance `stale` finding = load-bearing (inbound links) + mtime             | ❌ not usage-driven; skills rarely wikilinked, so they slip through |
| Curator: **usage telemetry** (`.usage.json`)       | Audit log records **writes only**, never reads/uses                            | ❌ missing                                                          |
| Curator: **pinning** (protect a skill)             | —                                                                              | ❌ missing                                                          |
| Curator: never auto-delete, archive + rollback     | Proposals never auto-apply; deletion stays human                               | ✅ (philosophy matches)                                             |
| Curator: per-run reports                           | `GET /api/maintenance` findings + audit log                                    | ✅                                                                  |
| "Learns your taste"                                | `proposalStats.ts` threshold tuning (item #2)                                  | ✅ (bonus; Hermes has no equivalent)                                |

**Takeaway:** fsbrain is ~80% of the way there. The missing 20% is a
skill-scoped lifecycle and the usage signal that drives it.

## 3. Design principles (inherited from the repo)

Any implementation must stay inside the repo's existing guarantees
(`AGENTS.md`, `implementation.md` §6):

- **Offline & deterministic.** No LLM, no network. Same corpus → same findings.
  (This mirrors Hermes' own default: its LLM consolidation pass is **off by
  default**; only the deterministic pruning is always-on.)
- **Pure core in `@repo/shared`**, unit tests co-located in `apps/api` (node
  vitest). NodeNext relative imports keep explicit `.js` extensions.
- **Propose, don't write.** Anything a human should sign off on becomes an edit
  **proposal**; resolution stays **human-only** (`agent:` resolver → 403).
- **Provenance is mandatory.** Any new mutating path reads `X-Actor` and appends
  an `AuditEntry`. A new curator actor is `agent:curator`.
- **`.fsbrain/` sandboxing intact.** New state lives under `.fsbrain/`, excluded
  from the tree/watcher; hidden segments stay rejected at `pathResolver`.
- **Report-only first.** Ship the read-only report before any auto-filing, the
  same way `GET /api/maintenance` preceded `POST /api/maintenance/scan`.

## 4. Proposed design (phased)

Three slices, each independently shippable and each reusing existing plumbing.

### Phase 1 — Pure skill-curator report (no new telemetry)

A new pure helper + a read-only endpoint + an MCP tool, mirroring the
`GET /api/maintenance` preview. Findings are **skill-scoped** and use only
signals the vault already computes.

**`@repo/shared/src/skillCurator.ts`**

```ts
export type SkillCuratorKind = 'incomplete' | 'duplicate_skill' | 'stale_skill';

/** A safe, reversible fix, shaped 1:1 onto an edit proposal (like maintenance). */
export interface SkillCuratorSuggestion {
  action: 'create' | 'update';
  path: string;
  content?: string;
  note: string;
}

export interface SkillCuratorFinding {
  kind: SkillCuratorKind;
  /** Skill note path(s) the finding concerns, sorted. */
  paths: string[];
  detail: string;
  /** `duplicate_skill` only — note-level TF-IDF cosine, 4dp. */
  score?: number;
  /** `incomplete` only — canonical sections the skill is missing. */
  missingSections?: string[];
  /** A safe, reversible proposal suggestion, when an auto-fix is appropriate. */
  suggestion?: SkillCuratorSuggestion;
}

export interface CurateSkillsOptions {
  /** Note-level cosine ≥ this flags two skills as duplicates (default 0.8). */
  duplicateThreshold?: number;
  /** Canonical skill sections (default: the Hermes house set below). */
  requiredSections?: string[];
  /** Reference "now" (ISO) — opt-in staleness, like `scanVault`. Omit to skip. */
  now?: string;
  /** Per-skill last-modified (logical path → ISO), from file mtime. */
  modifiedAt?: Readonly<Record<string, string>>;
  /** Flag a skill `stale_skill` after this many days unchanged (default 60). */
  staleAfterDays?: number;
}

export function curateSkills(
  documents: readonly { path: string; content: string }[],
  options?: CurateSkillsOptions,
): SkillCuratorFinding[];
```

Findings computed (all deterministic, report-only unless noted):

- **`incomplete`** — a skill note missing canonical sections. Default required
  set matches Hermes' `SKILL.md` house format: **When to Use / Procedure /
  Pitfalls / Verification**. _Actionable_: suggest an `update` that appends the
  missing section stubs (never rewrites existing content), so the human can flesh
  them out. This is the strongest Phase-1 value — it makes agent-authored skills
  converge on a consistent, reusable shape.
- **`duplicate_skill`** — two `type: skill` notes with note-level TF-IDF cosine
  ≥ `duplicateThreshold`. Report-only consolidation hint (a merge is never
  auto). Reuses the exact similarity machinery in `maintenance.ts`
  (`tokenize` + `buildNoteVector` + `cosine`).
- **`stale_skill`** — a skill unchanged for > `staleAfterDays`. Opt-in (only when
  `now` + `modifiedAt` are passed, exactly like `scanVault`'s freshness). Unlike
  the generic `stale` finding, it does **not** require inbound wikilinks —
  procedural skills are rarely linked, so mtime alone is the honest signal.
  Report-only. (Phase 2 upgrades this from "unchanged" to "unused".)

**Pinning:** a skill with frontmatter **`pinned: true`** is exempt from
`duplicate_skill` and `stale_skill` (never surfaced for archival/merge). This is
the fsbrain analog of `hermes curator pin` — declarative, in the note the human
already owns, no new store.

**Endpoint + tool**

- `GET /api/skills/curator?duplicateThreshold=&staleAfterDays=` → `{ findings }`.
  Preview only, files nothing. Mirrors `GET /api/maintenance`.
- MCP tool **`curate_skills`** (would be the 27th tool) → same endpoint. Its
  description nudges the agent to `propose_edit` a fleshed-out or consolidated
  skill, closing the loop with human review.

### Phase 2 — Skill usage telemetry (the true Curator signal)

The Hermes Curator is _usage_-driven. fsbrain logs writes but not reads, so
Phase 2 adds a minimal, best-effort **use log** — mirroring the existing
`AuditLog` / `QuestionLog` pattern — and turns `stale_skill` from "unchanged"
into "unused".

**`.fsbrain/skill-usage.jsonl`** (a `SkillUsageLog`, beside `audit.jsonl`):

```jsonc
{ "ts": "2026-07-08T09:12:03Z", "actor": "agent:mcp", "path": "skills/deploy.md", "event": "use" }
{ "ts": "2026-07-08T09:15:41Z", "actor": "human",     "path": "skills/deploy.md", "event": "list" }
```

- `event: "use"` — appended (best-effort) when a **skill note** is read via
  `GET /api/file` / `read_note`. Detecting "is this a skill" is a
  `parseFrontmatter` the read already does for the etag.
- `event: "list"` — appended when a skill is returned by `GET /api/skills`
  (discovery intent; the Hermes `view_count` analog).
- **Best-effort, never fails the call** — identical guarantee to the question
  log's "logging never fails the `think` call".

**Pure aggregator** (`@repo/shared`):

```ts
export interface SkillUsage {
  useCount: number;
  viewCount: number;
  lastUsedAt: string | null;
}
export function summarizeSkillUsage(
  entries: readonly SkillUsageEntry[],
): Record<string, SkillUsage>;
```

`curateSkills` gains an optional `usageByPath?: Record<string, SkillUsage>`; when
present, `stale_skill` fires on **`useCount === 0` (or last use older than
`staleAfterDays`)** — Hermes-faithful non-use, not just non-edit. `patch_count`
needs no new signal: it is already derivable from the audit log (an `update` on
a skill path).

> **Tradeoff to flag for review:** a `GET /api/file` on a skill would now have a
> write side effect (the best-effort log append). Precedent exists — `think` is
> a `GET` that writes `questions.jsonl` — but reads are hotter, so this should be
> (a) skill-only, (b) fire-and-forget, and (c) gated by an opt-out
> (`SKILL_USAGE_LOG=0`). Reviewers may prefer to scope it to the MCP `read_note`
> path (agent reads) rather than every web file open. **Open question A** below.

### Phase 3 — Filing, lifecycle state & config (full parity)

- **`POST /api/skills/curator/scan`** files the actionable findings as
  proposals (`agent:curator`, category `curator:<kind>`), **idempotent** —
  dedupes against pending _and_ rejected proposals, exactly like
  `runMaintenanceScan` / `scanFeedback`. Only safe edits are ever filed:
  `incomplete` → append section stubs; `duplicate_skill` → append a
  `> See also [[other]]` cross-link (never a merge/delete).
- **Auto-tuning for free:** because findings carry `category: curator:duplicate_skill`,
  the existing `proposalStats` loop (item #2) tunes the duplicate threshold from
  the human's approve/reject history — no new learning code.
- **Lifecycle surface:** `curateSkills` can expose a per-skill
  `state: 'active' | 'stale' | 'dormant'` derived from usage + age, for a future
  web **Curator** panel (sibling to Maintenance/Review). "Archival" maps to a
  **human-approved** move to an `archive/` folder or a `status: archived`
  frontmatter flag — never an auto-delete (fsbrain has no auto-delete, by design).
- **Optional scheduler:** `SKILL_CURATOR_INTERVAL_MS` (off unless set), matching
  the existing `MAINTENANCE_INTERVAL_MS` / `FEEDBACK_INTERVAL_MS` timers.

## 5. Files touched (estimate)

| Area                                        | Change                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/shared/src/skillCurator.ts`       | **new** pure helper (`curateSkills`)                                             |
| `packages/shared/src/skillUsage.ts`         | **new** pure aggregator (Phase 2)                                                |
| `packages/shared/src/index.ts`              | export the new types/helpers                                                     |
| `apps/api/src/storage/skillUsageLog.ts`     | **new** `SkillUsageLog` (Phase 2), mirrors `questionLog.ts`                      |
| `apps/api/src/routes/files.ts`              | `GET /api/skills/curator`, `POST .../scan`, use-log hooks                        |
| `apps/api/src/server.ts`                    | optional `SKILL_CURATOR_INTERVAL_MS` timer (Phase 3)                             |
| `apps/mcp/src/server.ts`                    | register `curate_skills` tool (27th)                                             |
| `apps/api/src/__tests__/`                   | `skillCurator.test.ts`, `skillUsage.test.ts` (pure)                              |
| `apps/api/src/routes/`                      | `skillCurator.test.ts` (endpoint + provenance + idempotence)                     |
| `apps/mcp/src/__tests__/freshClone.test.ts` | bump tool-count assertion 26 → 27                                                |
| docs                                        | `implementation.md` status tables, `AGENTS.md` tool table, README/CONNECT counts |

**Reuse, don't duplicate:** the note-level cosine currently lives in **both**
`semantic.ts` and `maintenance.ts`. Rather than add a third copy, Phase 1 should
extract a tiny shared `noteSimilarity` (or import `maintenance.ts`'s helpers) —
a small, optional cleanup called out here so it isn't missed.

## 6. Testing plan

- **Pure** (`apps/api/src/__tests__/skillCurator.test.ts`): incomplete-section
  detection (and the exact scaffold produced), duplicate-skill pairing at/above
  threshold, opt-in staleness with an injected `now` + `modifiedAt`, `pinned:
true` exemption, and that non-skill notes are ignored.
- **Pure** (`skillUsage.test.ts`): counter aggregation, `lastUsedAt` via parsed
  timestamps (not string compare — same care as `findKnowledgeGaps`).
- **Endpoint** (`routes/skillCurator.test.ts`): preview shape; scan files
  proposals as `agent:curator`; re-running is idempotent (no dupes vs
  pending/rejected); resolution stays human-only.
- **e2e:** extend the fresh-clone MCP test's tool-count assertion (26 → 27).
- No retrieval-eval floors change (this doesn't touch ranking).

## 7. Alternatives considered

- **Extend `scanVault` instead of a new endpoint.** Rejected for Phase 1: the
  curator is skill-scoped and has its own section/pinning semantics; bolting it
  onto the general maintenance scan would blur the finding taxonomy. A separate
  surface keeps both cohesive (and it can still share `maintenance.ts` helpers).
- **LLM consolidation (merge skills into umbrellas).** Out of scope — it breaks
  the offline guarantee. This is the same line the repo already draws for
  contradiction detection and for `think`'s optional synthesis (gated behind
  `OPENROUTER_API_KEY`). Hermes itself ships consolidation **off by default** for
  the same cost/risk reasons.
- **Derive usage purely from the audit log (no read log).** Considered for
  Phase 2. The audit log gives `patch_count` for free but **no read/use signal**
  — the very thing that makes Hermes' Curator work — so a lightweight use log is
  the minimum honest addition. Phase 1 deliberately needs none of it.

## 8. Non-goals

Explicitly **not** proposed (out of fsbrain's local/offline/human-gated scope):

- Auto-delete or auto-archive of skills (always human-approved).
- A cron **daemon** (fsbrain uses optional interval env timers + on-demand).
- Hermes' **cross-session chat search / dialectic user modeling** (Honcho,
  `USER.md`) — fsbrain has no chat sessions; its "memory" _is_ the notes.
- Skill **bundles**, slash-command skills, media delivery — Hermes UX, not vault
  concerns.

## 9. Open questions for maintainers

- **A.** Should the `use` event fire on **every** `GET /api/file` of a skill, or
  only on the MCP `read_note` path (agent reads)? The latter avoids adding a
  write to the web app's hot read path.
- **B.** Is `pinned: true` frontmatter the right pin mechanism, or should
  pinning piggyback on the schema pack / an explicit `status:` field?
- **C.** Ship Phase 1 (report-only, no telemetry) alone first, and gate Phases
  2–3 behind its reception? (Recommended.)
- **D.** Default `requiredSections` — adopt Hermes' set verbatim (**When to Use /
  Procedure / Pitfalls / Verification**) or align to the vault's existing
  skill-note phrasing (goal / steps / gotchas)?

## 10. Suggested sequence

**Phase 1 (pure report + `curate_skills` tool) → Phase 2 (use log →
usage-driven staleness) → Phase 3 (filing + tuning + optional panel).** Each
lands on the existing safety net (proposals, audit, `.fsbrain/` logs) and adds
**no new subsystem** — the same discipline that shipped skill notes, the
question log, and review-queue tuning.
