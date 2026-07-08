/**
 * Pure, offline **skill curator** — a maintenance pass scoped to the vault's
 * **skill notes** (`type: skill`). The vault already _grows_ skills (an agent
 * `propose_edit`s a playbook after learning one), but nothing _tends_ them, so
 * incomplete, redundant, or long-untouched skills accumulate and dilute
 * `list_skills`. This helper surfaces those, inspired by the Curator in Nous
 * Research's Hermes Agent — but the fsbrain way: deterministic, no model, and
 * report-only (a human acts on a finding via the proposal queue; nothing here
 * writes or deletes).
 *
 * It finds three kinds of problem, all scoped to skill notes:
 * - `incomplete` — a skill missing the canonical sections a good playbook has
 *   (When to Use / Procedure / Pitfalls / Verification, configurable). This is
 *   the one actionable finding: it carries an `update` suggestion that _appends_
 *   stubs for the missing sections (never rewrites existing content).
 * - `duplicate_skill` — two skills whose bodies are near-duplicates (note-level
 *   TF-IDF cosine ≥ threshold, via the shared `similarity.ts`). Report-only — a
 *   merge is a human judgement, never automatic.
 * - `stale_skill` — a skill unchanged for a long time. Opt-in: only computed
 *   when the caller passes `now` + `modifiedAt` (file mtimes), exactly like the
 *   maintenance scan's freshness. Report-only.
 *
 * A skill with frontmatter **`pinned: true`** is exempt from `duplicate_skill`
 * and `stale_skill` (the human has locked it in) — but is still checked for
 * `incomplete`, since improving a pinned skill's content is always welcome. This
 * mirrors Hermes' pin, which blocks archival/merge but not content edits.
 *
 * Everything here is pure + dependency-free so it runs in both the Node API and
 * the browser and is unit-tested in isolation (its tests live in `apps/api`). It
 * recognizes skills via the same `parseSkill` as `list_skills` and scores
 * similarity via the same `findDuplicatePairs` as the maintenance scan, so it
 * can never drift from either.
 */
import { parseNote, type ParsedNote } from './markdown.js';
import { findDuplicatePairs } from './similarity.js';
import { parseSkill } from './skills.js';

/** The kinds of skill-library problem the curator can report. */
export type SkillCuratorKind = 'incomplete' | 'duplicate_skill' | 'stale_skill';

/**
 * A safe, reversible fix for a finding, shaped 1:1 onto an edit proposal (the
 * same `{ action, path, content?, note }` a human reviews). Phase 1 only ever
 * suggests an `incomplete` scaffold — a merge or archive is never auto-fixed.
 */
export interface SkillCuratorSuggestion {
  action: 'create' | 'update';
  /** Logical path the proposal targets. */
  path: string;
  /** Full proposed content (existing note + appended section stubs). */
  content?: string;
  /** Rationale carried onto the proposal. */
  note: string;
}

/** A single skill-library problem the curator found. */
export interface SkillCuratorFinding {
  kind: SkillCuratorKind;
  /** The skill note path(s) this finding concerns, sorted for determinism. */
  paths: string[];
  /** Human-readable description of the problem. */
  detail: string;
  /** Note-level cosine in [0, 1], 4dp — `duplicate_skill` findings only. */
  score?: number;
  /** Canonical sections the skill is missing — `incomplete` findings only. */
  missingSections?: string[];
  /** A safe, reversible proposal suggestion, when an automatic fix is appropriate. */
  suggestion?: SkillCuratorSuggestion;
}

export interface CurateSkillsOptions {
  /** Note-level cosine ≥ this flags two skills as duplicates (default `0.8`). */
  duplicateThreshold?: number;
  /**
   * Canonical sections every skill should document. A skill missing any of them
   * is flagged `incomplete`. Defaults to the Hermes house set (see
   * {@link DEFAULT_SKILL_SECTIONS}).
   */
  requiredSections?: readonly string[];
  /**
   * Reference "now" (ISO string) for freshness. Omit to skip `stale_skill`
   * detection entirely — so callers that don't pass it get the other findings
   * unchanged.
   */
  now?: string;
  /**
   * Per-skill last-modified timestamps (logical path → ISO string). A skill with
   * no entry here is never flagged `stale_skill`. Required (with `now`) for
   * freshness.
   */
  modifiedAt?: Readonly<Record<string, string>>;
  /** Flag a skill `stale_skill` after this many days unchanged (default `60`). */
  staleAfterDays?: number;
}

/** The canonical skill sections, matching Hermes' `SKILL.md` house format. */
export const DEFAULT_SKILL_SECTIONS = ['When to Use', 'Procedure', 'Pitfalls', 'Verification'];

/** Note-level TF-IDF cosine at/above which two skills are flagged duplicates. */
export const DEFAULT_SKILL_DUPLICATE_THRESHOLD = 0.8;
const DEFAULT_SKILL_STALE_AFTER_DAYS = 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// A stable kind order for the final, deterministic finding list.
const KIND_RANK: Record<SkillCuratorKind, number> = {
  incomplete: 0,
  duplicate_skill: 1,
  stale_skill: 2,
};

/** One resolved skill note plus the bits the curator repeatedly needs. */
interface SkillDoc {
  path: string;
  content: string;
  /** Frontmatter `name:`, else first heading, else filename (from `parseSkill`). */
  name: string;
  /** Document body with frontmatter removed. */
  body: string;
  /** True when frontmatter declares `pinned: true` (exempt from dup/stale). */
  pinned: boolean;
}

/** True when a note's frontmatter declares `pinned: true` (case-insensitive). */
function isPinned(note: ParsedNote): boolean {
  const value = note.frontmatter['pinned'];
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

/**
 * Section headings (level ≥ 2, i.e. `## …`) in a body, outside fenced code, with
 * their `#`s stripped. The document's `#` title is deliberately excluded — a
 * canonical skill section is a `##` heading (matching Hermes' `SKILL.md`
 * format), so a title like `# When to Use Git Bisect` never counts as a section.
 * Fence tracking remembers the opening marker (`` ` `` vs `~`) so a `~~~` line
 * inside a ``` block can't prematurely end it.
 */
function sectionHeadings(body: string): string[] {
  const headings: string[] = [];
  let openFence: string | null = null;
  for (const line of body.split('\n')) {
    const fence = /^[ \t]*(```+|~~~+)/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      if (openFence === null) {
        openFence = marker;
      } else if (marker === openFence) {
        openFence = null;
      }
      continue;
    }
    if (openFence !== null) {
      continue;
    }
    const match = /^#{2,6}\s+(.+?)\s*$/.exec(line);
    if (match) {
      headings.push(match[1].trim());
    }
  }
  return headings;
}

/**
 * The required sections a body does NOT document, preserving `required` order. A
 * section counts as present when some `##`-level heading equals it or begins
 * with it at a word boundary (case-insensitive) — so `## Verification steps` and
 * `## Verification:` satisfy `Verification`, but `## VerificationFailure` does
 * not.
 */
function missingSections(body: string, required: readonly string[]): string[] {
  const headings = sectionHeadings(body).map((heading) => heading.toLowerCase());
  return required.filter((section) => {
    const wanted = section.toLowerCase();
    return !headings.some(
      (heading) =>
        heading === wanted || heading.startsWith(`${wanted} `) || heading.startsWith(`${wanted}:`),
    );
  });
}

/** Append `## <section>` stubs for the missing sections, one trailing newline. */
function appendSectionStubs(content: string, missing: readonly string[]): string {
  const body = content.replace(/\s+$/, '');
  const stubs = missing.map((section) => `## ${section}\n\n_TODO: fill this in._`).join('\n\n');
  return `${body}\n\n${stubs}\n`;
}

/** Display label for a skill path: the basename without the `.md` extension. */
function labelOf(skillPath: string): string {
  const base = skillPath.split('/').pop() ?? skillPath;
  return base.replace(/\.md$/i, '');
}

/** Total order over findings so the same corpus always yields the same list. */
function sortFindings(findings: SkillCuratorFinding[]): SkillCuratorFinding[] {
  return [...findings].sort((a, b) => {
    if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) {
      return KIND_RANK[a.kind] - KIND_RANK[b.kind];
    }
    const pa = a.paths.join('\u0000');
    const pb = b.paths.join('\u0000');
    return pa.localeCompare(pb) || a.detail.localeCompare(b.detail);
  });
}

/**
 * Scan a corpus of notes for skill-library problems and return a deterministic,
 * stably-ordered list of findings. Pure: no I/O, no model, no mutation — the
 * same documents (and `now`) always yield the same findings. Non-skill notes are
 * ignored.
 */
export function curateSkills(
  documents: readonly { path: string; content: string }[],
  options: CurateSkillsOptions = {},
): SkillCuratorFinding[] {
  const duplicateThreshold = options.duplicateThreshold ?? DEFAULT_SKILL_DUPLICATE_THRESHOLD;
  const requiredSections = options.requiredSections ?? DEFAULT_SKILL_SECTIONS;

  // Resolve skill notes once (parse each candidate a single time).
  const skills: SkillDoc[] = [];
  for (const { path, content } of documents) {
    const summary = parseSkill(path, content);
    if (!summary) {
      continue;
    }
    const note = parseNote(content);
    skills.push({ path, content, name: summary.name, body: note.body, pinned: isPinned(note) });
  }

  const findings: SkillCuratorFinding[] = [];
  const byPath = new Map(skills.map((skill) => [skill.path, skill]));

  // --- incomplete: a skill missing canonical sections. Checked for every skill
  // (even pinned ones — improving content is always fine). Actionable: suggest
  // appending stubs for just the missing sections.
  for (const skill of skills) {
    const missing = missingSections(skill.body, requiredSections);
    if (missing.length === 0) {
      continue;
    }
    findings.push({
      kind: 'incomplete',
      paths: [skill.path],
      detail: `"${skill.name}" is missing skill section(s): ${missing.join(', ')}.`,
      missingSections: missing,
      suggestion: {
        action: 'update',
        path: skill.path,
        content: appendSectionStubs(skill.content, missing),
        note: `"${skill.name}" is missing ${missing.join(', ')}; appending section stub(s) for you to fill in.`,
      },
    });
  }

  // --- duplicate_skill: two skills whose bodies are near-duplicates. Pinned
  // skills are exempt (a locked-in skill is not a consolidation candidate), so
  // drop any pair touching one. Report-only — a merge is never suggested.
  const skillCorpus = skills.map((skill) => ({ path: skill.path, content: skill.content }));
  for (const { a, b, score } of findDuplicatePairs(skillCorpus, duplicateThreshold)) {
    if (byPath.get(a)?.pinned || byPath.get(b)?.pinned) {
      continue;
    }
    findings.push({
      kind: 'duplicate_skill',
      paths: [a, b],
      detail: `"${labelOf(a)}" and "${labelOf(b)}" are highly similar (cosine ${score.toFixed(2)}); consider consolidating them.`,
      score: Number(score.toFixed(4)),
    });
  }

  // --- stale_skill: a skill unchanged for a long time. Opt-in (needs `now` +
  // `modifiedAt`). Pinned skills are exempt. Report-only.
  if (options.now && options.modifiedAt) {
    const nowMs = Date.parse(options.now);
    const staleAfterDays = options.staleAfterDays ?? DEFAULT_SKILL_STALE_AFTER_DAYS;
    const staleMs = staleAfterDays * MS_PER_DAY;
    if (!Number.isNaN(nowMs)) {
      for (const skill of skills) {
        if (skill.pinned) {
          continue;
        }
        const modifiedIso = options.modifiedAt[skill.path];
        if (!modifiedIso) {
          continue; // unknown last-modified — never guess a skill is stale
        }
        const modifiedMs = Date.parse(modifiedIso);
        if (Number.isNaN(modifiedMs)) {
          continue;
        }
        const ageMs = nowMs - modifiedMs;
        if (ageMs <= staleMs) {
          continue;
        }
        const ageDays = Math.floor(ageMs / MS_PER_DAY);
        findings.push({
          kind: 'stale_skill',
          paths: [skill.path],
          detail: `"${skill.name}" (skill) hasn't changed in ${ageDays} days — review whether it is still current.`,
        });
      }
    }
  }

  return sortFindings(findings);
}
