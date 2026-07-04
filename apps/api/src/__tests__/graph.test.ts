import { describe, expect, it } from 'vitest';
import { buildGraph, extractFrontmatterRelations, type GraphDocument } from '@repo/shared';

describe('buildGraph', () => {
  it('builds nodes per note and edges per resolved wikilink', () => {
    const docs: GraphDocument[] = [
      { path: 'a.md', content: '# A\n\nSee [[b]].' },
      { path: 'b.md', content: '# B\n\nNo links here.' },
    ];

    const graph = buildGraph(docs);

    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['a.md', 'b.md']);
    expect(graph.nodes.find((n) => n.id === 'a.md')?.label).toBe('a');
    expect(graph.edges).toEqual([{ source: 'a.md', target: 'b.md' }]);
  });

  it('keeps unresolved link targets as distinct placeholder nodes', () => {
    const graph = buildGraph([{ path: 'a.md', content: 'Links to [[Nowhere]].' }]);

    const placeholder = graph.nodes.find((n) => n.id === 'Nowhere');
    expect(placeholder).toEqual({ id: 'Nowhere', label: 'Nowhere', tags: [], unresolved: true });
    expect(graph.nodes.find((n) => n.id === 'a.md')?.unresolved).toBeUndefined();
    expect(graph.edges).toContainEqual({ source: 'a.md', target: 'Nowhere' });
  });

  it('attaches the declared frontmatter type (normalized) to real-note nodes only', () => {
    const graph = buildGraph([
      { path: 'ann.md', content: '---\ntype: Person\n---\n# Ann\n\nLinks [[missing]].' },
      { path: 'plain.md', content: '# Plain note, no type' },
    ]);

    expect(graph.nodes.find((n) => n.id === 'ann.md')?.type).toBe('person');
    // Untyped real notes and unresolved placeholders carry no `type` key at all.
    expect(graph.nodes.find((n) => n.id === 'plain.md')).not.toHaveProperty('type');
    expect(graph.nodes.find((n) => n.id === 'missing')).not.toHaveProperty('type');
  });

  it('carries a typed relation onto the edge and attaches tags to nodes', () => {
    const docs: GraphDocument[] = [
      {
        path: 'claim.md',
        content: '---\ntags: [thesis]\n---\nBacked by [[evidence|rel:supports]].',
      },
      { path: 'evidence.md', content: '# Evidence' },
    ];

    const graph = buildGraph(docs);

    expect(graph.nodes.find((n) => n.id === 'claim.md')?.tags).toEqual(['thesis']);
    expect(graph.edges).toContainEqual({
      source: 'claim.md',
      target: 'evidence.md',
      type: 'supports',
    });
  });

  it('drops self-links and de-dupes repeated edges', () => {
    const docs: GraphDocument[] = [
      { path: 'a.md', content: 'See [[a]] and [[b]] and [[b]] again.' },
      { path: 'b.md', content: '# B' },
    ];

    const graph = buildGraph(docs);

    // No self-edge a.md -> a.md, and only one a.md -> b.md edge.
    expect(graph.edges).toEqual([{ source: 'a.md', target: 'b.md' }]);
  });

  it('ignores wikilinks inside fenced code', () => {
    const graph = buildGraph([
      { path: 'a.md', content: '```\n[[b]]\n```\n\nreal [[c]]' },
      { path: 'b.md', content: '# B' },
      { path: 'c.md', content: '# C' },
    ]);

    expect(graph.edges).toEqual([{ source: 'a.md', target: 'c.md' }]);
  });

  it('self-wires typed edges from frontmatter fields (field name = relation)', () => {
    const docs: GraphDocument[] = [
      {
        path: 'meeting.md',
        content:
          '---\ntype: meeting\nrelated: [[project]]\nattendees: [[alice]], [[bob]]\n---\n# Sync',
      },
      { path: 'project.md', content: '# Project' },
      { path: 'alice.md', content: '# Alice' },
      { path: 'bob.md', content: '# Bob' },
    ];

    const graph = buildGraph(docs);

    // `related: [[project]]` -> typed `related` edge, no `rel:` discipline.
    expect(graph.edges).toContainEqual({
      source: 'meeting.md',
      target: 'project.md',
      type: 'related',
    });
    // Inline array under one field -> one typed edge per link.
    expect(graph.edges).toContainEqual({
      source: 'meeting.md',
      target: 'alice.md',
      type: 'attendees',
    });
    expect(graph.edges).toContainEqual({
      source: 'meeting.md',
      target: 'bob.md',
      type: 'attendees',
    });
    // `type: meeting` is a plain scalar (no `[[...]]`) — never an edge.
    expect(graph.edges.some((e) => e.type === 'meeting' || e.target === 'meeting')).toBe(false);
  });

  it('recognises YAML block-list relations and unresolved frontmatter targets', () => {
    const docs: GraphDocument[] = [
      {
        path: 'idea.md',
        content: '---\nrelated:\n  - "[[known]]"\n  - "[[missing]]"\n---\n# Idea',
      },
      { path: 'known.md', content: '# Known' },
    ];

    const graph = buildGraph(docs);

    expect(graph.edges).toContainEqual({
      source: 'idea.md',
      target: 'known.md',
      type: 'related',
    });
    // Unresolved frontmatter target becomes a placeholder node + typed edge.
    expect(graph.nodes.find((n) => n.id === 'missing')).toMatchObject({
      id: 'missing',
      unresolved: true,
    });
    expect(graph.edges).toContainEqual({
      source: 'idea.md',
      target: 'missing',
      type: 'related',
    });
  });

  it('collapses a redundant untyped body edge when a typed edge connects the same pair', () => {
    const docs: GraphDocument[] = [
      {
        path: 'a.md',
        content: '---\nrelated: [[Foo]]\n---\nSee also [[Foo]] for details.',
      },
      { path: 'foo.md', content: '# Foo' },
    ];

    const graph = buildGraph(docs);

    // Only the typed `related` edge survives — the bare prose mention is subsumed.
    const aToFoo = graph.edges.filter((e) => e.source === 'a.md' && e.target === 'foo.md');
    expect(aToFoo).toEqual([{ source: 'a.md', target: 'foo.md', type: 'related' }]);
  });

  it('keeps distinct typed edges between the same pair', () => {
    const docs: GraphDocument[] = [
      {
        path: 'a.md',
        content: '---\nrelated: [[b]]\n---\nAlso [[b|rel:supports]].',
      },
      { path: 'b.md', content: '# B' },
    ];

    const graph = buildGraph(docs);

    const aToB = graph.edges.filter((e) => e.source === 'a.md' && e.target === 'b.md');
    expect(aToB).toEqual([
      { source: 'a.md', target: 'b.md', type: 'related' },
      { source: 'a.md', target: 'b.md', type: 'supports' },
    ]);
  });

  it('prefers a link-level rel: type over the frontmatter field name', () => {
    const docs: GraphDocument[] = [
      { path: 'a.md', content: '---\nsee: [[b|rel:supports]]\n---\n# A' },
      { path: 'b.md', content: '# B' },
    ];

    const graph = buildGraph(docs);

    expect(graph.edges).toContainEqual({ source: 'a.md', target: 'b.md', type: 'supports' });
  });

  it('can restore body-only edges (frontmatter links stay untyped) when disabled', () => {
    const docs: GraphDocument[] = [
      { path: 'a.md', content: '---\nrelated: [[b]]\n---\n# A' },
      { path: 'b.md', content: '# B' },
    ];

    const withWiring = buildGraph(docs);
    expect(withWiring.edges).toEqual([{ source: 'a.md', target: 'b.md', type: 'related' }]);

    const bodyOnly = buildGraph(docs, { frontmatterRelations: false });
    // The frontmatter link is scanned as a plain, untyped body edge.
    expect(bodyOnly.edges).toEqual([{ source: 'a.md', target: 'b.md' }]);
  });
});

describe('extractFrontmatterRelations', () => {
  it('returns nothing when there is no frontmatter or no wikilink values', () => {
    expect(extractFrontmatterRelations('# Just a body [[link]]')).toEqual([]);
    expect(extractFrontmatterRelations('---\ntype: person\ntags: [a, b]\n---\nBody')).toEqual([]);
  });

  it('extracts one relation per link, keyed by the field name', () => {
    const relations = extractFrontmatterRelations(
      '---\nmentor: [[Jane]]\nrelated: [[Foo]], [[Bar]]\n---\nBody',
    );

    expect(relations).toEqual([
      { target: 'Jane', type: 'mentor' },
      { target: 'Foo', type: 'related' },
      { target: 'Bar', type: 'related' },
    ]);
  });

  it('ignores an unterminated frontmatter block', () => {
    expect(extractFrontmatterRelations('---\nrelated: [[Foo]]\nno closing fence')).toEqual([]);
  });
});
