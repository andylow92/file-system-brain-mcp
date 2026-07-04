/**
 * Pure helpers for **schema packs** — a small, canonical vocabulary of note
 * `type:` values (person, meeting, project…) with the typed relations each type
 * is allowed to declare. A schema pack turns the vault's free-form frontmatter
 * into a lightly-typed knowledge base without adding a database or a write path.
 * It powers three things off the metadata the vault already stores:
 *
 * - **Graph colouring.** Each page type carries a stable colour, so the graph
 *   view can tint a note by *what it is* (a person vs a meeting) rather than only
 *   by its first tag. The graph attaches each note's declared `type` to its node
 *   (see `graph.ts`); the renderer resolves the colour via {@link getPageType}.
 * - **Validation.** {@link validateVault} flags a note that declares an unknown
 *   `type:`, or a **frontmatter** relation that type is not allowed to have, or a
 *   relation pointing at the wrong kind of note. These surface (report-only) as a
 *   `schema` maintenance finding the human reviews — never an auto-edit.
 * - **Retrieval boosting (future).** The same type/relation metadata is the seam
 *   a later ranker can boost on; that half is intentionally not wired yet.
 *
 * Scope note: validation covers **frontmatter-declared** relations (the ones a
 * schema pack governs — `owner: [[Ann]]`, `attendees: [[Bob]]`). Free-form body
 * `[[Target|rel:type]]` annotations are deliberately not validated; treating
 * every prose link as a schema violation would be noise.
 *
 * Everything here is pure, deterministic, and dependency-free (no model, no
 * network, no API key), consistent with the rest of `@repo/shared`. Recognising
 * a note's declared relations reuses the graph's `extractFrontmatterRelations`,
 * and target resolution reuses `resolveWikilink`, so schema validation can never
 * drift from what the graph and backlinks consider a link.
 */
import { extractFrontmatterRelations } from './graph.js';
import { parseNote, resolveWikilink } from './markdown.js';

/** One relation a page type is allowed to declare in its frontmatter. */
export interface RelationRule {
  /** Relation name = the frontmatter field name, e.g. `owner`, `attendees`. */
  name: string;
  /**
   * Canonical page type(s) this relation may point to. Empty/omitted means the
   * target type is unconstrained (any note, e.g. the universal `related`).
   */
  targetTypes?: string[];
  /** One-line description of what the relation means. */
  description?: string;
}

/** One canonical note type in a {@link SchemaPack}. */
export interface PageType {
  /** Canonical frontmatter `type:` value, lowercase (e.g. `person`). */
  type: string;
  /** Display label for UIs and legends (e.g. `Person`). */
  label: string;
  /** Stable colour (hex) for graph node rendering and the type legend. */
  color: string;
  /** One-line description of what notes of this type represent. */
  description: string;
  /** Typed relations a note of this type may declare in its frontmatter. */
  relations: RelationRule[];
}

/** An ordered set of canonical page types. */
export type SchemaPack = readonly PageType[];

/** The kinds of schema problem {@link validateVault} can report. */
export type SchemaViolationKind = 'unknown_type' | 'disallowed_relation' | 'target_type_mismatch';

/** A single schema-conformance problem found in one note. */
export interface SchemaViolation {
  kind: SchemaViolationKind;
  /** Logical path of the note that declares the problem. */
  path: string;
  /** Human-readable explanation. */
  detail: string;
  /**
   * The offending value: the unknown `type:` for `unknown_type`, otherwise the
   * relation name for `disallowed_relation` / `target_type_mismatch`.
   */
  value: string;
}

/**
 * The built-in schema pack: a compact, general-purpose vocabulary adapted from
 * gbrain's canonical types, cut to a size a personal vault actually uses. Every
 * type allows the universal `related` association; the rest are typed relations
 * with a target-type constraint so the graph stays meaningful. `skill` is the
 * same `type: skill` convention the skill-notes feature already relies on.
 */
export const DEFAULT_SCHEMA_PACK: SchemaPack = [
  {
    type: 'note',
    label: 'Note',
    color: '#8a94a6',
    description: 'A generic note with no more specific type.',
    relations: [{ name: 'related', description: 'A free association to any other note.' }],
  },
  {
    type: 'person',
    label: 'Person',
    color: '#6fa8c7',
    description: 'A person — colleague, contact, author.',
    relations: [
      { name: 'related' },
      { name: 'works_on', targetTypes: ['project'], description: 'A project the person works on.' },
      { name: 'reports_to', targetTypes: ['person'], description: 'The person they report to.' },
      { name: 'member_of', targetTypes: ['topic'], description: 'A team/area they belong to.' },
    ],
  },
  {
    type: 'project',
    label: 'Project',
    color: '#d4a76a',
    description: 'A piece of work with an outcome and an owner.',
    relations: [
      { name: 'related' },
      { name: 'owner', targetTypes: ['person'], description: 'The person accountable for it.' },
      { name: 'depends_on', targetTypes: ['project'], description: 'A project it depends on.' },
      { name: 'about', targetTypes: ['topic'], description: 'The topic it advances.' },
    ],
  },
  {
    type: 'meeting',
    label: 'Meeting',
    color: '#b58bc4',
    description: 'Notes from a meeting or call.',
    relations: [
      { name: 'related' },
      { name: 'attendees', targetTypes: ['person'], description: 'People who attended.' },
      { name: 'about', targetTypes: ['topic', 'project'], description: 'What it was about.' },
      { name: 'decided', targetTypes: ['decision'], description: 'A decision it produced.' },
    ],
  },
  {
    type: 'idea',
    label: 'Idea',
    color: '#c9a14a',
    description: 'A proposal, hypothesis, or spark to develop.',
    relations: [
      { name: 'related' },
      { name: 'about', targetTypes: ['topic'], description: 'The topic it concerns.' },
      { name: 'inspired_by', targetTypes: ['source'], description: 'A source that sparked it.' },
    ],
  },
  {
    type: 'topic',
    label: 'Topic',
    color: '#7cb89a',
    description: 'A subject area or map-of-content hub.',
    relations: [
      { name: 'related' },
      { name: 'part_of', targetTypes: ['topic'], description: 'A broader topic it sits under.' },
    ],
  },
  {
    type: 'decision',
    label: 'Decision',
    color: '#d98a72',
    description: 'A recorded decision and its rationale.',
    relations: [
      { name: 'related' },
      { name: 'about', targetTypes: ['topic', 'project'], description: 'What it decides.' },
      { name: 'supersedes', targetTypes: ['decision'], description: 'A decision it replaces.' },
    ],
  },
  {
    type: 'source',
    label: 'Source',
    color: '#84b06a',
    description: 'A reference — article, book, clipping, link.',
    relations: [
      { name: 'related' },
      { name: 'author', targetTypes: ['person'], description: 'Who wrote it.' },
      { name: 'about', targetTypes: ['topic'], description: 'What it covers.' },
    ],
  },
  {
    type: 'task',
    label: 'Task',
    color: '#c77f9e',
    description: 'A discrete to-do or action item.',
    relations: [
      { name: 'related' },
      { name: 'owner', targetTypes: ['person'], description: 'Who owns the task.' },
      { name: 'about', targetTypes: ['project', 'topic'], description: 'What it serves.' },
      { name: 'depends_on', targetTypes: ['task', 'project'], description: 'A prerequisite.' },
    ],
  },
  {
    type: 'skill',
    label: 'Skill',
    color: '#5b9aa0',
    description: 'A reusable procedural playbook (see skill notes).',
    relations: [
      { name: 'related' },
      { name: 'about', targetTypes: ['topic'], description: 'The area it applies to.' },
    ],
  },
];

/** Normalize a raw `type:` value for lookup: trimmed, lowercased. */
function normalizeType(raw: string): string {
  return raw.trim().toLowerCase();
}

/** A note's declared frontmatter `type:`, normalized to lowercase, or undefined. */
function declaredType(content: string): string | undefined {
  const type = parseNote(content).frontmatter['type'];
  if (typeof type !== 'string') {
    return undefined;
  }
  const normalized = normalizeType(type);
  return normalized || undefined;
}

/**
 * Look up a canonical {@link PageType} by its `type:` value (case-insensitive),
 * or `undefined` when the value is not part of the pack. Used by the graph
 * renderer to colour a node from its declared type.
 */
export function getPageType(
  type: string | undefined,
  pack: SchemaPack = DEFAULT_SCHEMA_PACK,
): PageType | undefined {
  if (!type) {
    return undefined;
  }
  const wanted = normalizeType(type);
  return pack.find((pageType) => pageType.type === wanted);
}

/** Display label for a note path: the basename without the `.md` extension. */
function labelOf(notePath: string): string {
  const base = notePath.split('/').pop() ?? notePath;
  return base.replace(/\.md$/i, '');
}

/** Total order over violations so the same corpus always yields the same list. */
const VIOLATION_RANK: Record<SchemaViolationKind, number> = {
  unknown_type: 0,
  disallowed_relation: 1,
  target_type_mismatch: 2,
};

/**
 * Validate a corpus of notes against a schema pack and return a deterministic,
 * stably-ordered list of {@link SchemaViolation}s. Pure: no I/O, no model, no
 * mutation — the same documents always yield the same violations.
 *
 * Rules, all conservative to keep the signal low-noise:
 * - **`unknown_type`** — the note declares a `type:` not in the pack. (An
 *   untyped note is always fine; typing is opt-in.)
 * - **`disallowed_relation`** — a *frontmatter* relation whose name is not among
 *   the note type's allowed relations (only checked for a known type).
 * - **`target_type_mismatch`** — a frontmatter relation whose resolved target is
 *   a note of a canonical type the rule does not permit. Skipped when the target
 *   is unresolved (that is a broken link, reported separately) or is
 *   untyped/unknown (never guess).
 */
export function validateVault(
  documents: readonly { path: string; content: string }[],
  pack: SchemaPack = DEFAULT_SCHEMA_PACK,
): SchemaViolation[] {
  const allPaths = documents.map((doc) => doc.path);

  // Resolve each note to its canonical type (only when known), so a relation's
  // target type can be checked without re-parsing every note per relation.
  const typeByPath = new Map<string, string>();
  for (const doc of documents) {
    const declared = declaredType(doc.content);
    if (declared && getPageType(declared, pack)) {
      typeByPath.set(doc.path, declared);
    }
  }

  const violations: SchemaViolation[] = [];
  for (const doc of documents) {
    const declared = declaredType(doc.content);
    if (!declared) {
      continue; // untyped notes are always valid
    }
    const label = labelOf(doc.path);
    const pageType = getPageType(declared, pack);
    if (!pageType) {
      violations.push({
        kind: 'unknown_type',
        path: doc.path,
        value: declared,
        detail: `"${label}" declares type "${declared}", which is not in the schema pack.`,
      });
      continue; // can't validate relations against an unknown type
    }

    const rulesByName = new Map(pageType.relations.map((rule) => [rule.name, rule]));
    for (const relation of extractFrontmatterRelations(doc.content)) {
      const rule = rulesByName.get(relation.type);
      if (!rule) {
        violations.push({
          kind: 'disallowed_relation',
          path: doc.path,
          value: relation.type,
          detail: `"${label}" (type ${declared}) declares relation "${relation.type}", which is not allowed for that type.`,
        });
        continue;
      }
      if (!rule.targetTypes || rule.targetTypes.length === 0) {
        continue; // relation exists and is unconstrained
      }
      const resolved = resolveWikilink(relation.target, allPaths);
      if (!resolved) {
        continue; // broken link — the maintenance broken_link scan handles it
      }
      const targetType = typeByPath.get(resolved);
      if (!targetType) {
        continue; // target is untyped/unknown — never guess a mismatch
      }
      if (!rule.targetTypes.includes(targetType)) {
        violations.push({
          kind: 'target_type_mismatch',
          path: doc.path,
          value: relation.type,
          detail: `"${label}"'s "${relation.type}" points to "${labelOf(resolved)}" (type ${targetType}), but "${relation.type}" should point to ${rule.targetTypes.join(' or ')}.`,
        });
      }
    }
  }

  return violations.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      VIOLATION_RANK[a.kind] - VIOLATION_RANK[b.kind] ||
      a.value.localeCompare(b.value) ||
      a.detail.localeCompare(b.detail),
  );
}
