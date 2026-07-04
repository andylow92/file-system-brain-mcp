import { describe, expect, it } from 'vitest';

import { DEFAULT_SCHEMA_PACK, getPageType, validateVault } from '@repo/shared';

const doc = (path: string, content: string) => ({ path, content });

describe('DEFAULT_SCHEMA_PACK', () => {
  it('defines canonical types with a colour and the universal `related` relation', () => {
    for (const pageType of DEFAULT_SCHEMA_PACK) {
      expect(pageType.type).toBe(pageType.type.toLowerCase());
      expect(pageType.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(pageType.relations.some((rule) => rule.name === 'related')).toBe(true);
    }
    const names = DEFAULT_SCHEMA_PACK.map((pageType) => pageType.type);
    expect(names).toContain('person');
    expect(names).toContain('meeting');
    expect(names).toContain('project');
    // `skill` shares the type used by the skill-notes feature.
    expect(names).toContain('skill');
  });
});

describe('getPageType', () => {
  it('looks a type up case-insensitively and returns undefined for unknown/empty', () => {
    expect(getPageType('person')?.label).toBe('Person');
    expect(getPageType('PERSON')?.type).toBe('person');
    expect(getPageType('  Meeting  ')?.type).toBe('meeting');
    expect(getPageType('unicorn')).toBeUndefined();
    expect(getPageType(undefined)).toBeUndefined();
    expect(getPageType('')).toBeUndefined();
  });
});

describe('validateVault — unknown_type', () => {
  it('flags a declared type that is not in the pack', () => {
    const violations = validateVault([doc('a.md', '---\ntype: unicorn\n---\n# A')]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: 'unknown_type', path: 'a.md', value: 'unicorn' });
  });

  it('leaves an untyped note alone (typing is opt-in)', () => {
    expect(validateVault([doc('a.md', '# A\n\nNo frontmatter here.')])).toEqual([]);
    expect(validateVault([doc('b.md', '---\ntags: [x]\n---\n# B')])).toEqual([]);
  });

  it('accepts a canonical type with no relations', () => {
    expect(validateVault([doc('a.md', '---\ntype: note\n---\n# A')])).toEqual([]);
  });
});

describe('validateVault — disallowed_relation', () => {
  it('flags a frontmatter relation the note type is not allowed to declare', () => {
    // `person` has no `attendees` relation (that belongs to `meeting`).
    const violations = validateVault([
      doc('ann.md', '---\ntype: person\nattendees: [[bob]]\n---\n# Ann'),
      doc('bob.md', '---\ntype: person\n---\n# Bob'),
    ]);
    const disallowed = violations.filter((v) => v.kind === 'disallowed_relation');
    expect(disallowed).toHaveLength(1);
    expect(disallowed[0]).toMatchObject({ path: 'ann.md', value: 'attendees' });
  });

  it('accepts the universal `related` relation on any type, to any target', () => {
    const violations = validateVault([
      doc('m.md', '---\ntype: meeting\nrelated: [[misc]]\n---\n# Standup'),
      doc('misc.md', '# Misc'),
    ]);
    expect(violations).toEqual([]);
  });
});

describe('validateVault — target_type_mismatch', () => {
  it('flags a relation pointing at the wrong kind of note', () => {
    // `project.owner` must point to a `person`; here it points to a `project`.
    const violations = validateVault([
      doc('apollo.md', '---\ntype: project\nowner: [[gemini]]\n---\n# Apollo'),
      doc('gemini.md', '---\ntype: project\n---\n# Gemini'),
    ]);
    const mismatch = violations.filter((v) => v.kind === 'target_type_mismatch');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]).toMatchObject({ path: 'apollo.md', value: 'owner' });
    expect(mismatch[0].detail).toContain('gemini');
  });

  it('accepts a relation pointing at an allowed target type', () => {
    const violations = validateVault([
      doc('apollo.md', '---\ntype: project\nowner: [[ann]]\n---\n# Apollo'),
      doc('ann.md', '---\ntype: person\n---\n# Ann'),
    ]);
    expect(violations).toEqual([]);
  });

  it('does not guess when the target is unresolved (a broken link) or untyped', () => {
    const unresolved = validateVault([
      doc('apollo.md', '---\ntype: project\nowner: [[nobody]]\n---\n# Apollo'),
    ]);
    expect(unresolved.filter((v) => v.kind === 'target_type_mismatch')).toEqual([]);

    const untyped = validateVault([
      doc('apollo.md', '---\ntype: project\nowner: [[ann]]\n---\n# Apollo'),
      doc('ann.md', '# Ann (no type)'),
    ]);
    expect(untyped.filter((v) => v.kind === 'target_type_mismatch')).toEqual([]);
  });
});

describe('validateVault — determinism', () => {
  it('returns a stable order (by path, then kind) regardless of input order', () => {
    const docs = [
      doc('z.md', '---\ntype: unicorn\n---\n# Z'),
      doc('a.md', '---\ntype: person\nattendees: [[a]]\n---\n# A'),
    ];
    const first = validateVault(docs);
    const second = validateVault([...docs].reverse());
    expect(first).toEqual(second);
    expect(first.map((v) => v.path)).toEqual(['a.md', 'z.md']);
  });

  it('validates against a caller-supplied pack', () => {
    const pack = [
      { type: 'unicorn', label: 'Unicorn', color: '#ffffff', description: '', relations: [] },
    ];
    // `unicorn` is canonical in this pack, so no unknown_type.
    expect(validateVault([doc('a.md', '---\ntype: unicorn\n---\n# A')], pack)).toEqual([]);
    // `person` is not in the custom pack, so it is now the unknown one.
    const violations = validateVault([doc('b.md', '---\ntype: person\n---\n# B')], pack);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('unknown_type');
  });
});
