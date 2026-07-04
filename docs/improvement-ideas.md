# Improvement ideas — self-improvement loops

> Brainstorm of where to take the vault next, focused on **closing feedback
> loops** the existing infrastructure already collects signal for (audit log,
> proposal approve/reject outcomes, `think` gap analysis, dream-cycle
> maintenance). Captured 2026-06; complements the prioritized backlog in
> [`implementation.md`](implementation.md) (items #13–20) rather than
> replacing it.

The repo already has every piece a self-improvement loop needs — provenance,
a human-gated proposal queue, retrieval with gap analysis, and an offline
maintenance scan. What's missing is that nothing _reads the signal back_.
These ideas close those loops, in rough order of leverage.

---

## 1. Skill notes — procedural memory the agent grows itself

✅ **Done** — backlog item #21 in
[`implementation.md`](implementation.md). The vault stores **declarative**
knowledge (facts, notes); this added a convention for **procedural**
knowledge: notes with `type: skill` frontmatter (optional `name:` /
`description:`) containing a goal, steps, and gotchas.

- Shipped as `@repo/shared` `skills.ts` (`parseSkill`, `listSkills`),
  `GET /api/skills?q=...`, and the `list_skills` MCP tool (22nd).
- Reading a skill is a plain `read_note`; `get_skill` was dropped as
  redundant with it — one new read surface is enough.
- The `list_skills` tool description nudges the agent to check for a skill
  before a non-trivial task and to `propose_edit` a new/updated skill after
  completing one — "write down what worked." The human approves it in the
  Review tab like any proposal.

Over time the agent distills its own successful workflows into reusable,
human-audited playbooks. Pairs naturally with backlog #19 (schema packs, now
shipped) — `skill` is one of the canonical page types in `DEFAULT_SCHEMA_PACK`.

## 2. Learn from the review queue

✅ **Done.** Proposals recorded approve/reject outcomes, but nothing read that
signal back; now a pure helper mines it.

- Each filed proposal carries a `category` (`maintenance:<kind>`,
  `feedback:<channel>`; ad-hoc proposals fall back to `actor:action`), and
  `@repo/shared` `proposalStats.ts` (`summarizeOutcomes`, `recommendThreshold`)
  tallies per-category approval rates.
- `GET /api/proposals/stats` + the `proposal_stats` MCP tool return
  `{ categories, recommendations }`; the tool description nudges the agent to
  back off categories the human routinely rejects.
- Auto-tunes the dream cycle: `runMaintenanceScan` reads the
  `maintenance:duplicate` history and nudges the cosine threshold — up when
  cross-links keep getting rejected, down when they're always approved —
  guarded by a resolved-sample floor so a fresh vault uses the default.
  Resolution stays human-only; only the propensity to propose tunes. Tests:
  `apps/api` `__tests__/proposalStats.test.ts` (pure) +
  `routes/proposalStats.test.ts` (endpoint + adoption).

The proposal store is a labeled training set we already collect; a
deterministic, offline tuner fits the repo's "no LLM, pure helpers" constraint.

## 3. Question log → gap-driven growth

✅ **Done** — backlog item #22 in
[`implementation.md`](implementation.md). `think` used to compute
`uncoveredTerms` and `weakCoverage` per query, then throw them away; now
every `think` query is persisted with its gap signal (and `X-Actor`
attribution) to `.fsbrain/questions.jsonl`, beside the audit log.

- Shipped as a `QuestionLog` store (mirrors `AuditLog`), pure
  `findKnowledgeGaps` in `@repo/shared` `questions.ts`,
  `GET /api/questions?limit&minCount`, and the `recent_questions` MCP tool
  (23rd) returning `{ entries, gaps }`.
- A **recurring gap** is a term left uncovered by ≥ `minCount` questions
  (default 2; asking the same thing twice counts — repetition is demand).
  The tool description nudges the agent to `propose_edit` a note filling a
  recurring gap, closing the loop with human review.
- Deferred from v1: surfacing gaps as maintenance findings in the web Review
  tab (needs a new `MaintenanceFinding` kind + UI work; the agent-facing
  loop above already works without it).

The vault learns what knowledge it's missing from actual usage rather than
static analysis.

## 4. Implicit relevance feedback for ranking

When an agent runs `hybrid_search` and then `read_note`s result #3 and cites
it via `think`, that's a relevance label. Correlate search→read/cite
sequences from the audit log and use them two ways:

- a small learned per-note ranking prior;
- auto-generated fixtures for the **retrieval eval harness** (backlog #20).

The eval harness is the prerequisite for _any_ self-tuning — the system must
have a regression measure before it's allowed to adjust itself.

## 5. Freshness / decay scoring

✅ **Done.** "Stale but load-bearing" notes — old **and** heavily cited — are
the highest-risk content, so the dream-cycle scan now surfaces them as a
`stale` maintenance finding ("is this still accurate?").

- "Load-bearing" is proxied by **inbound `[[wikilink]]` count** (the signal
  `scanVault` already computes); "last-modified" comes from each note's
  **file mtime**. Reads aren't logged, so retrieval frequency isn't available —
  inbound-citation count is the honest, fully-deterministic stand-in.
- Added as a new `MaintenanceKind` in `@repo/shared` `maintenance.ts`, **opt-in**
  via `scanVault`'s `now` + `modifiedAt` options (so every pre-existing caller is
  unchanged); the API route derives `modifiedAt` from `fs.stat` mtimes. Defaults:
  flag a note with ≥ 3 inbound links unchanged for > 90 days. **Report-only** (no
  safe auto-edit), shown in the web Maintenance panel and the `run_maintenance`
  tool output. Tests: `apps/api` `__tests__/maintenance.test.ts` (pure freshness
  cases) + `routes/maintenance.test.ts` (mtime-aged via `utimes`).

Cheap, deterministic, and makes the dream cycle feel genuinely alive.

---

## Quick wins that unlock the above

- **CI pipeline.** ✅ Done — `.github/workflows/ci.yml` runs
  `npm test`, `npm run lint`, `npm run build`, and `npm run format` on every
  PR and push to `main`, so the eval harness and the fresh-clone MCP e2e
  gate every change.
- **Git-backed version history for the vault.** Auto-commit on writes (or
  snapshot per proposal approval) gives undo for agent writes — a trust
  unlock that makes the loops above safe to run more autonomously.
- **Backlog #18–19** (self-wiring typed edges, schema packs) pair naturally
  with skill notes.
- **Real embeddings (#13)** behind the existing seam — with the eval harness
  (#20) in place first, so the swap is _proven_ to improve recall rather than
  assumed.

## Suggested sequence

**CI → eval harness (#20) → skill notes (#1) → question log (#3) →
review-queue tuning (#2).** Every self-improvement mechanism lands on top of
a safety net, and each reuses the proposal/audit/think plumbing — no new
subsystems. _CI, the eval harness, skill notes (#1), the question log (#3),
and review-queue tuning (#2) have all shipped._
