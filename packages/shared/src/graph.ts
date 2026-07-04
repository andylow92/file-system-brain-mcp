/**
 * Pure helpers for building the vault's wikilink **knowledge graph** — the set
 * of notes (nodes) and the `[[wikilink]]` references between them (edges). The
 * graph powers both the human-facing Graph view and the agent-facing
 * `GET /api/graph` traversal endpoint.
 *
 * It reuses the same link extraction (`extractWikilinks` + `resolveWikilink`)
 * that backs `/api/backlinks`, so the graph and the backlinks panel can never
 * disagree about what links where. A link whose target does not resolve to a
 * real note is kept as a distinct **placeholder** node (`unresolved: true`), so
 * the human can see the gaps in their vault. The optional typed relation from a
 * `[[Target|rel:supports]]` link is carried on the edge.
 *
 * The graph also **self-wires typed edges from frontmatter**: any frontmatter
 * field whose value contains one or more `[[wikilinks]]` becomes a typed edge
 * with the field name as the relation type — so `related: [[Foo]]` wires a
 * `related` edge without the manual `[[Foo|rel:related]]` discipline in the
 * body. The presence of `[[...]]` is the signal, so plain scalar metadata
 * (`type: person`, `tags: [a, b]`) is skipped without a reserved-key list.
 *
 * Everything here is pure + dependency-free so it runs in both the Node API and
 * the browser and is unit-tested in isolation (its tests live in `apps/api`).
 */
import {
  FRONTMATTER_KEY_LINE,
  FRONTMATTER_LIST_ITEM,
  extractTags,
  extractWikilinks,
  parseFrontmatter,
  resolveWikilink,
  splitFrontmatter,
} from './markdown.js';

export interface GraphNode {
  /** Stable node id: a real note's logical path, or the raw target for a placeholder. */
  id: string;
  /** Display name — the basename without the `.md` extension. */
  label: string;
  /** Tags declared by the note (frontmatter + inline `#tags`); empty for placeholders. */
  tags: string[];
  /**
   * The note's declared frontmatter `type:`, normalized to lowercase (e.g.
   * `person`). Present only for real notes that declare one; a consumer resolves
   * it to a colour/label via the schema pack's `getPageType`. Absent for untyped
   * notes and placeholders.
   */
  type?: string;
  /** True when this node is an unresolved link target, not a real note on disk. */
  unresolved?: boolean;
}

export interface GraphEdge {
  /** Source note's logical path. */
  source: string;
  /** Target node id (a note path, or a placeholder id for an unresolved link). */
  target: string;
  /** Typed relation from `[[Target|rel:type]]`, when the link carried one. */
  type?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** A note to include in the graph (the cached index's `{ path, content }` shape). */
export interface GraphDocument {
  path: string;
  content: string;
}

/** Options controlling how {@link buildGraph} derives edges. */
export interface BuildGraphOptions {
  /**
   * Derive typed edges from frontmatter fields whose values contain
   * `[[wikilinks]]` (the field name becomes the relation type). Defaults to
   * `true`. Set `false` to fall back to body-only edges (the pre-self-wiring
   * behaviour), which also treats any frontmatter `[[link]]` as a plain
   * untyped body edge.
   */
  frontmatterRelations?: boolean;
}

/** A typed relation declared in a note's frontmatter. */
export interface FrontmatterRelation {
  /** Raw (unresolved) link target, e.g. `folder/Note`. */
  target: string;
  /** Relation type — the frontmatter field name, or the link's own `rel:` type. */
  type: string;
}

/**
 * Derive typed relations from a note's frontmatter. Any frontmatter field whose
 * value contains one or more `[[wikilinks]]` yields one relation per link, with
 * the field name as the relation type — so `related: [[Foo]]` (or a block list
 * of them under `related:`) produces a `related` relation with no manual
 * `[[Foo|rel:related]]` in the body. Fields with no wikilink values (plain
 * scalars like `type: person`, `tags: [a, b]`) contribute nothing, so no
 * reserved-key list is needed. A link that carries its own `rel:` type keeps it,
 * overriding the field name.
 *
 * **Recognised forms:** inline (`related: [[Foo]], [[Bar]]`) and YAML block-list
 * (`related:\n  - "[[Foo]]"`) only. Consistent with the vault's minimal-YAML
 * subset, `[[links]]` inside a folded/literal block scalar (`key: |`) are NOT
 * attributed to the key. Fence-finding and line classification are shared with
 * `parseFrontmatter` via `splitFrontmatter` + `FRONTMATTER_KEY_LINE` /
 * `FRONTMATTER_LIST_ITEM`, but this scanner reads each value's **raw text**
 * (rather than the minimal-YAML parsed value) so `[[...]]` stays intact — the
 * `[...]` inline-array parser would otherwise mangle it. Note that value text is
 * run through `extractWikilinks`, which strips code spans first, so a backtick
 * in a relation value can drop content before link extraction (a non-issue for
 * real relation fields).
 */
export function extractFrontmatterRelations(content: string): FrontmatterRelation[] {
  const block = splitFrontmatter(content);
  if (!block) {
    return [];
  }

  const relations: FrontmatterRelation[] = [];
  let currentKey: string | null = null;

  const collect = (key: string, value: string): void => {
    for (const link of extractWikilinks(value)) {
      relations.push({ target: link.target, type: link.type ?? key });
    }
  };

  for (const line of block.lines) {
    const listItem = FRONTMATTER_LIST_ITEM.exec(line);
    if (currentKey && listItem) {
      collect(currentKey, listItem[1]);
      continue;
    }

    const kv = FRONTMATTER_KEY_LINE.exec(line);
    if (!kv) {
      continue;
    }
    currentKey = kv[1];
    collect(currentKey, kv[2]);
  }

  return relations;
}

/** Display label for a node id: the basename without the `.md` extension. */
function labelForPath(id: string): string {
  const base = id.split('/').pop() ?? id;
  return base.replace(/\.md$/i, '');
}

/**
 * A note's declared frontmatter `type:`, normalized to lowercase, or undefined.
 * Read here (rather than via the schema module) so the graph stays a leaf of the
 * dependency tree — the schema pack is applied by the *consumer* for colouring.
 */
function nodeType(content: string): string | undefined {
  const type = parseFrontmatter(content).frontmatter['type'];
  if (typeof type !== 'string') {
    return undefined;
  }
  const normalized = type.trim().toLowerCase();
  return normalized || undefined;
}

/**
 * Build the wikilink graph from a corpus of notes. Every note becomes a node;
 * every resolved `[[wikilink]]` becomes an edge to the linked note; every
 * unresolved link becomes an edge to a placeholder node (`unresolved: true`).
 * Self-links and duplicate edges (same source/target/type) are dropped. Nodes
 * and edges are returned in a stable, sorted order for deterministic output.
 *
 * When a pair of notes is connected by both a typed edge (a frontmatter relation
 * or a `rel:` link) and a bare untyped body mention, the redundant **untyped**
 * edge is collapsed away — a formal relation subsumes a prose mention, so
 * consumers see one connection, not a doubled one. Genuinely distinct typed
 * edges between the same pair (e.g. `related` + `supports`) are all kept.
 */
export function buildGraph(
  documents: readonly GraphDocument[],
  options: BuildGraphOptions = {},
): GraphData {
  const { frontmatterRelations = true } = options;
  const allPaths = documents.map((doc) => doc.path);
  const nodes = new Map<string, GraphNode>();

  // A node for every real note first, so a later unresolved target can never
  // shadow a real note (and tags are always attached to the real note).
  for (const doc of documents) {
    const type = nodeType(doc.content);
    nodes.set(doc.path, {
      id: doc.path,
      label: labelForPath(doc.path),
      tags: extractTags(doc.content),
      ...(type ? { type } : {}),
    });
  }

  const edgeKeys = new Set<string>();
  const edges: GraphEdge[] = [];

  const addEdge = (source: string, rawTarget: string, type?: string): void => {
    const resolved = resolveWikilink(rawTarget, allPaths);

    let targetId: string;
    if (resolved) {
      targetId = resolved;
    } else {
      const cleaned = rawTarget.replace(/^\.\//, '').trim();
      if (!cleaned) {
        return;
      }
      targetId = cleaned;
      if (!nodes.has(targetId)) {
        nodes.set(targetId, {
          id: targetId,
          label: labelForPath(targetId),
          tags: [],
          unresolved: true,
        });
      }
    }

    // Skip self-links — they add no information to the graph.
    if (targetId === source) {
      return;
    }

    // JSON-encode the triple as the de-dupe key so a path/target containing a
    // space (or any other character) can never collide — same approach as
    // context.ts's dedupeKey, and plain text (no delimiter bytes).
    const key = JSON.stringify([source, targetId, type ?? '']);
    if (edgeKeys.has(key)) {
      return;
    }
    edgeKeys.add(key);
    edges.push({ source, target: targetId, ...(type ? { type } : {}) });
  };

  for (const doc of documents) {
    // Self-wiring: typed edges declared in frontmatter (field name = relation
    // type). Processed first so a `related: [[Foo]]` edge is typed rather than
    // being swept up as an untyped body link.
    if (frontmatterRelations) {
      for (const rel of extractFrontmatterRelations(doc.content)) {
        addEdge(doc.path, rel.target, rel.type);
      }
    }

    // Body links (untyped, or aliased with `rel:`). With self-wiring on, the
    // frontmatter block is stripped so its `[[links]]` are not double-counted
    // as plain body edges; with it off, the whole document is scanned (the
    // original behaviour).
    const body = frontmatterRelations ? parseFrontmatter(doc.content).body : doc.content;
    for (const link of extractWikilinks(body)) {
      addEdge(doc.path, link.target, link.type);
    }
  }

  // Collapse a redundant untyped edge when a typed edge already connects the
  // same pair — the formal relation subsumes the bare mention.
  const typedPairs = new Set<string>();
  for (const edge of edges) {
    if (edge.type) {
      typedPairs.add(JSON.stringify([edge.source, edge.target]));
    }
  }
  const collapsedEdges = edges.filter(
    (edge) =>
      edge.type !== undefined || !typedPairs.has(JSON.stringify([edge.source, edge.target])),
  );

  const sortedNodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const sortedEdges = collapsedEdges.sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.target.localeCompare(b.target) ||
      (a.type ?? '').localeCompare(b.type ?? ''),
  );

  return { nodes: sortedNodes, edges: sortedEdges };
}
