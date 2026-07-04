/**
 * Pure, deterministic **vault maintenance** scan — the offline core of the
 * "dream cycle". It looks for vault-hygiene problems and, for the actionable
 * ones, attaches a **safe, reversible** suggestion that maps 1:1 onto an edit
 * proposal a human approves in the Review tab. It never writes anything itself.
 *
 * Detected, fully offline (no model, no network, no API key):
 * - `broken_link` — a `[[wikilink]]` that resolves to no note. Suggestion: a
 *   `create` proposal for a stub of the missing target (approve → it exists,
 *   reject → nothing happens).
 * - `orphan` — a note with no inbound and no outbound **resolved** wikilinks (an
 *   isolated node). Report-only: there is no safe auto-edit, so no suggestion.
 * - `duplicate` — a pair of notes whose note-level TF-IDF cosine similarity is
 *   ≥ a threshold. Suggestion (conservative): an `update` proposal that appends
 *   a `> See also [[other]]` cross-link to the first note — never a merge.
 * - `stale` — a **load-bearing** note (many inbound `[[wikilinks]]`, i.e. heavily
 *   cited) that has not changed in a long time: old + relied-upon is the highest
 *   risk content, so it is surfaced for a "is this still accurate?" review.
 *   Report-only (there is no safe auto-edit), and **opt-in**: it is computed only
 *   when the caller passes a `now` reference time plus per-note `modifiedAt`
 *   timestamps (the API derives them from each file's mtime). Callers that omit
 *   them — including every pre-existing one — get exactly the prior behavior.
 * - `schema` — a note that violates the **schema pack**: an unknown `type:`, or a
 *   frontmatter relation that type is not allowed to declare, or a relation
 *   pointing at the wrong kind of note (see `schema.ts`). Report-only, and
 *   **opt-in**: computed only when the caller passes a `schemaPack`. Delegated to
 *   `validateVault`, so the two never drift.
 *
 * Everything here is pure + dependency-free so it runs in both the Node API and
 * the browser and is unit-tested in isolation (its tests live in `apps/api`). It
 * reuses the same `extractWikilinks` + `resolveWikilink` as `/api/backlinks` and
 * the graph, so its notion of "links" can never drift from the rest of the
 * vault. Similarity reuses the semantic engine's `tokenize`; the note-level
 * TF-IDF weighting below mirrors `semantic.ts`'s chunk-level scoring, applied per
 * whole note (it is re-derived here, so keep the two in step if you tune either).
 *
 * Out of scope for v1: contradiction detection. True contradiction finding needs
 * an LLM, which would break the offline guarantee — it is a documented follow-up
 * behind the same server-side `OPENROUTER_API_KEY` gate that `think`'s synthesis
 * uses, not built here.
 */
import { extractWikilinks, parseFrontmatter, resolveWikilink } from './markdown.js';
import { validateVault, type SchemaPack } from './schema.js';
import { tokenize } from './semantic.js';

/** The kinds of vault-hygiene problem a scan can report. */
export type MaintenanceKind = 'broken_link' | 'orphan' | 'duplicate' | 'stale' | 'schema';

/**
 * A safe, reversible fix for a finding, shaped to map 1:1 onto an edit proposal
 * (the same `{ action, path, content?, note }` a human reviews). Only `create`
 * (a missing-note stub) and `update` (append a cross-link) are ever suggested —
 * never a `delete`, so approving a maintenance proposal can never lose content.
 */
export interface MaintenanceSuggestion {
  action: 'create' | 'update';
  /** Logical path the proposal targets. */
  path: string;
  /** Full proposed content — a stub for `create`, the note + cross-link for `update`. */
  content?: string;
  /** Rationale carried onto the proposal. */
  note: string;
}

/** A single problem the scan found, optionally with a one-click proposal fix. */
export interface MaintenanceFinding {
  kind: MaintenanceKind;
  /** The real note paths this finding concerns, sorted for determinism. */
  paths: string[];
  /** Human-readable description of the problem. */
  detail: string;
  /** Similarity score in [0, 1], rounded to 4dp — `duplicate` findings only. */
  score?: number;
  /** A safe, reversible proposal suggestion, when an automatic fix is appropriate. */
  suggestion?: MaintenanceSuggestion;
}

export interface ScanVaultOptions {
  /** Note-level TF-IDF cosine ≥ this flags a duplicate pair (default `0.85`). */
  duplicateThreshold?: number;
  /**
   * Reference "now" (ISO string) for freshness. Omit to skip `stale` detection
   * entirely — so callers that don't pass it get the prior behavior unchanged.
   */
  now?: string;
  /**
   * Per-note last-modified timestamps (logical path → ISO string). A note with
   * no entry here is never flagged `stale`. Required (with `now`) for freshness.
   */
  modifiedAt?: Readonly<Record<string, string>>;
  /** Inbound `[[wikilinks]]` a note needs to count as load-bearing (default 3). */
  loadBearingMinInbound?: number;
  /** Flag a load-bearing note `stale` after this many days unchanged (default 90). */
  staleAfterDays?: number;
  /**
   * Validate notes against this schema pack, emitting a `schema` finding per
   * violation. Omit to skip schema validation entirely — so callers that don't
   * pass it (including every pre-existing one) get the prior behavior unchanged.
   * Pass `DEFAULT_SCHEMA_PACK` (from `schema.ts`) to use the built-in types.
   */
  schemaPack?: SchemaPack;
}

/** A note to scan (the cached index's `{ path, content }` shape). */
export interface MaintenanceDocument {
  path: string;
  content: string;
}

/** Note-level TF-IDF cosine at/above which a pair is flagged as a duplicate. */
export const DEFAULT_DUPLICATE_THRESHOLD = 0.85;
const DEFAULT_LOAD_BEARING_MIN_INBOUND = 3;
const DEFAULT_STALE_AFTER_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// A stable kind order for the final, deterministic finding list.
const KIND_RANK: Record<MaintenanceKind, number> = {
  broken_link: 0,
  duplicate: 1,
  schema: 2,
  stale: 3,
  orphan: 4,
};

/** Display label for a note path: the basename without the `.md` extension. */
function labelOf(notePath: string): string {
  const base = notePath.split('/').pop() ?? notePath;
  return base.replace(/\.md$/i, '');
}

/** The logical path a stub for a broken link target would live at. */
function stubPathFor(cleanedTarget: string): string {
  return /\.md$/i.test(cleanedTarget) ? cleanedTarget : `${cleanedTarget}.md`;
}

/** Minimal placeholder content for a stub note created from a broken link. */
function stubContent(label: string): string {
  return `# ${label}\n\n> Stub note created to resolve a broken [[wikilink]]. Fill in the details.\n`;
}

/** Append a `> See also [[label]]` cross-link, keeping one trailing newline. */
function appendCrossLink(content: string, targetLabel: string): string {
  return `${content.replace(/\s+$/, '')}\n\n> See also [[${targetLabel}]]\n`;
}

/**
 * Build a normalized TF-IDF vector for a note's tokens — the same weighting the
 * semantic engine (`semantic.ts`) uses per chunk, applied here at note level so
 * a pairwise cosine measures whole-note similarity. A normalized vector means
 * the dot product *is* the cosine.
 */
function buildNoteVector(tokens: string[], idf: (term: string) => number): Map<string, number> {
  const termFrequency = new Map<string, number>();
  for (const token of tokens) {
    termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
  }

  const vector = new Map<string, number>();
  let norm = 0;
  for (const [term, count] of termFrequency) {
    const weight = (1 + Math.log(count)) * idf(term);
    vector.set(term, weight);
    norm += weight * weight;
  }

  const magnitude = Math.sqrt(norm) || 1;
  for (const [term, weight] of vector) {
    vector.set(term, weight / magnitude);
  }
  return vector;
}

/** Cosine of two normalized vectors = their dot product (iterate the smaller). */
function cosine(a: Map<string, number>, b: Map<string, number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, weight] of small) {
    const other = large.get(term);
    if (other) {
      dot += weight * other;
    }
  }
  return dot;
}

/** Total order over findings so the same corpus always yields the same list. */
function sortFindings(findings: MaintenanceFinding[]): MaintenanceFinding[] {
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
 * Scan a corpus of notes for vault-hygiene problems and return a deterministic,
 * stably-ordered list of findings. Pure: no I/O, no model, no mutation — the
 * same documents always yield the same findings.
 */
export function scanVault(
  documents: readonly MaintenanceDocument[],
  options: ScanVaultOptions = {},
): MaintenanceFinding[] {
  const duplicateThreshold = options.duplicateThreshold ?? DEFAULT_DUPLICATE_THRESHOLD;
  const allPaths = documents.map((doc) => doc.path);
  const pathSet = new Set(allPaths);
  const contentByPath = new Map(documents.map((doc) => [doc.path, doc.content]));

  // --- Link analysis: resolved (real) out-targets, inbound sources, broken links.
  const resolvedOut = new Map<string, Set<string>>();
  const inbound = new Map<string, Set<string>>();
  for (const notePath of allPaths) {
    resolvedOut.set(notePath, new Set());
    inbound.set(notePath, new Set());
  }
  // Missing-target stub path → the set of notes that link to it.
  const brokenByStub = new Map<string, Set<string>>();

  for (const doc of documents) {
    for (const link of extractWikilinks(doc.content)) {
      const resolved = resolveWikilink(link.target, allPaths);
      if (resolved) {
        if (resolved === doc.path) {
          continue; // self-link — no information
        }
        resolvedOut.get(doc.path)!.add(resolved);
        inbound.get(resolved)!.add(doc.path);
        continue;
      }
      const cleaned = link.target.replace(/^\.\//, '').trim();
      if (!cleaned) {
        continue; // e.g. a bare `[[#heading]]` link within the same note
      }
      const stub = stubPathFor(cleaned);
      if (pathSet.has(stub)) {
        continue; // never propose creating over a real note
      }
      if (!brokenByStub.has(stub)) {
        brokenByStub.set(stub, new Set());
      }
      brokenByStub.get(stub)!.add(doc.path);
    }
  }

  const findings: MaintenanceFinding[] = [];

  // --- broken_link: one finding per missing target; suggest a stub `create`.
  for (const [stub, sources] of brokenByStub) {
    const sourcePaths = [...sources].sort((a, b) => a.localeCompare(b));
    const label = labelOf(stub);
    findings.push({
      kind: 'broken_link',
      paths: sourcePaths,
      detail: `${sourcePaths.length} note(s) link to "${label}", which resolves to no note.`,
      suggestion: {
        action: 'create',
        path: stub,
        content: stubContent(label),
        note: `Stub created to resolve a broken [[${label}]] link from ${sourcePaths.join(', ')}.`,
      },
    });
  }

  // --- orphan: a real note with no resolved inbound and no resolved outbound link.
  for (const notePath of allPaths) {
    if (resolvedOut.get(notePath)!.size === 0 && inbound.get(notePath)!.size === 0) {
      findings.push({
        kind: 'orphan',
        paths: [notePath],
        detail: `"${labelOf(notePath)}" has no inbound or outbound [[wikilinks]] (isolated note).`,
      });
    }
  }

  // --- duplicate: note-level TF-IDF cosine ≥ threshold. One vector per note,
  // O(n²) pairwise compare (fine for a local vault), each pair reported once.
  const noteTokens = documents.map((doc) => tokenize(parseFrontmatter(doc.content).body));
  const documentFrequency = new Map<string, number>();
  for (const tokens of noteTokens) {
    for (const term of new Set(tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const total = documents.length;
  const idf = (term: string) => Math.log(1 + total / ((documentFrequency.get(term) ?? 0) + 1));
  const vectors = noteTokens.map((tokens) => buildNoteVector(tokens, idf));

  for (let i = 0; i < documents.length; i += 1) {
    for (let j = i + 1; j < documents.length; j += 1) {
      // Two notes with no rankable tokens are not "duplicates" of each other.
      if (vectors[i].size === 0 || vectors[j].size === 0) {
        continue;
      }
      const score = cosine(vectors[i], vectors[j]);
      if (score < duplicateThreshold) {
        continue;
      }

      const [a, b] = [documents[i].path, documents[j].path].sort((x, y) => x.localeCompare(y));
      // If the two notes already cross-link (either direction), adding another
      // link is noise — report the duplicate, but suggest no edit.
      const alreadyLinked = resolvedOut.get(a)!.has(b) || resolvedOut.get(b)!.has(a);
      findings.push({
        kind: 'duplicate',
        paths: [a, b],
        detail: `"${labelOf(a)}" and "${labelOf(b)}" are highly similar (cosine ${score.toFixed(2)}); possible duplicates.`,
        score: Number(score.toFixed(4)),
        ...(alreadyLinked
          ? {}
          : {
              suggestion: {
                action: 'update',
                path: a,
                content: appendCrossLink(contentByPath.get(a) ?? '', labelOf(b)),
                note: `"${labelOf(a)}" and "${labelOf(b)}" look like near-duplicates (cosine ${score.toFixed(2)}); adding a cross-link rather than merging.`,
              },
            }),
      });
    }
  }

  // --- stale: a load-bearing note (many inbound links) that hasn't changed in a
  // long time. Opt-in: only runs when the caller supplies `now` + `modifiedAt`.
  // Report-only — there is no safe auto-edit for "is this still accurate?".
  if (options.now && options.modifiedAt) {
    const nowMs = Date.parse(options.now);
    const minInbound = options.loadBearingMinInbound ?? DEFAULT_LOAD_BEARING_MIN_INBOUND;
    const staleAfterDays = options.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
    const staleMs = staleAfterDays * MS_PER_DAY;
    if (!Number.isNaN(nowMs)) {
      for (const notePath of allPaths) {
        const inboundCount = inbound.get(notePath)!.size;
        if (inboundCount < minInbound) {
          continue; // not load-bearing — staleness here is low risk
        }
        const modifiedIso = options.modifiedAt[notePath];
        if (!modifiedIso) {
          continue; // unknown last-modified — never guess a note is stale
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
          kind: 'stale',
          paths: [notePath],
          detail: `"${labelOf(notePath)}" is load-bearing (${inboundCount} inbound [[wikilinks]]) but hasn't changed in ${ageDays} days — review whether it is still accurate.`,
        });
      }
    }
  }

  // --- schema: notes that violate the schema pack (unknown type, disallowed or
  // mis-targeted relation). Opt-in: only runs when the caller supplies a pack.
  // Report-only — the fix is a human editing frontmatter, not a safe auto-edit.
  if (options.schemaPack) {
    for (const violation of validateVault(documents, options.schemaPack)) {
      findings.push({
        kind: 'schema',
        paths: [violation.path],
        detail: violation.detail,
      });
    }
  }

  return sortFindings(findings);
}
