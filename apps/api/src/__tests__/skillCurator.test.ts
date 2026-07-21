import { describe, expect, it } from 'vitest';

import { curateSkills } from '@repo/shared';

const doc = (path: string, content: string) => ({ path, content });

/** A complete skill note (all canonical sections), used as a clean baseline. */
const completeSkill = (title: string, body = 'Some distinctive prose here.') =>
  [
    '---',
    'type: skill',
    `name: ${title}`,
    '---',
    `# ${title}`,
    '',
    '## When to Use',
    body,
    '',
    '## Procedure',
    '1. Step one.',
    '',
    '## Pitfalls',
    '- Watch out.',
    '',
    '## Verification',
    'Confirm it worked.',
    '',
  ].join('\n');

describe('curateSkills — incomplete', () => {
  it('flags a skill missing canonical sections and suggests appending stubs', () => {
    const content = [
      '---',
      'type: skill',
      'name: Deploy',
      '---',
      '# Deploy',
      '',
      'Run the script.',
    ].join('\n');
    const findings = curateSkills([doc('skills/deploy.md', content)]);

    const incomplete = findings.filter((f) => f.kind === 'incomplete');
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].paths).toEqual(['skills/deploy.md']);
    expect(incomplete[0].missingSections).toEqual([
      'When to Use',
      'Procedure',
      'Pitfalls',
      'Verification',
    ]);

    const suggestion = incomplete[0].suggestion!;
    expect(suggestion.action).toBe('update');
    expect(suggestion.path).toBe('skills/deploy.md');
    // Appends stubs without dropping the original body.
    expect(suggestion.content).toContain('Run the script.');
    expect(suggestion.content).toContain('## When to Use');
    expect(suggestion.content).toContain('## Verification');
    expect(suggestion.content).toContain('_TODO: fill this in._');
  });

  it('does not flag a skill that has every required section (heading prefixes count)', () => {
    const content = [
      '---',
      'type: skill',
      '---',
      '# Ship It',
      '## When to Use this skill',
      'Context.',
      '## Procedure',
      'Steps.',
      '## Pitfalls and gotchas',
      'Careful.',
      '## Verification',
      'Check.',
    ].join('\n');
    const findings = curateSkills([doc('skills/ship.md', content)]);
    expect(findings.filter((f) => f.kind === 'incomplete')).toHaveLength(0);
  });

  it('ignores headings inside fenced code when checking sections', () => {
    const content = [
      '---',
      'type: skill',
      '---',
      '# Trap',
      '```md',
      '## When to Use',
      '## Procedure',
      '## Pitfalls',
      '## Verification',
      '```',
    ].join('\n');
    const findings = curateSkills([doc('skills/trap.md', content)]);
    const incomplete = findings.find((f) => f.kind === 'incomplete');
    // All four fenced headings are code, not real sections — all still missing.
    expect(incomplete?.missingSections).toHaveLength(4);
  });

  it('does not let the H1 title masquerade as a section', () => {
    // Title starts with "When to Use" but there is no `## When to Use` section.
    const content = [
      '---',
      'type: skill',
      '---',
      '# When to Use Git Bisect',
      '## Procedure',
      'Steps.',
      '## Pitfalls',
      'Careful.',
      '## Verification',
      'Check.',
    ].join('\n');
    const findings = curateSkills([doc('skills/bisect.md', content)]);
    const incomplete = findings.find((f) => f.kind === 'incomplete');
    expect(incomplete?.missingSections).toEqual(['When to Use']);
  });

  it('requires a word boundary — "VerificationFailure" does not satisfy "Verification"', () => {
    const content = [
      '---',
      'type: skill',
      '---',
      '# X',
      '## When to Use',
      'a',
      '## Procedure',
      'b',
      '## Pitfalls',
      'c',
      '## VerificationFailure',
      'not the real section',
    ].join('\n');
    const findings = curateSkills([doc('skills/x.md', content)]);
    const incomplete = findings.find((f) => f.kind === 'incomplete');
    expect(incomplete?.missingSections).toEqual(['Verification']);
  });
});

describe('curateSkills — duplicate_skill', () => {
  it('flags two near-duplicate skills as a consolidation candidate (report-only)', () => {
    const shared = completeSkill('X', 'Configure the widget frobnicator with alpha beta gamma.');
    const findings = curateSkills([
      doc('skills/a.md', shared),
      doc('skills/b.md', shared.replace('# X', '# Y')),
    ]);

    const dup = findings.filter((f) => f.kind === 'duplicate_skill');
    expect(dup).toHaveLength(1);
    expect(dup[0].paths).toEqual(['skills/a.md', 'skills/b.md']);
    expect(dup[0].score).toBeGreaterThan(0.8);
    // Report-only: no auto-fix suggestion for a merge.
    expect(dup[0].suggestion).toBeUndefined();
  });

  it('never pairs a skill with a non-skill note', () => {
    const body = 'Configure the widget frobnicator with alpha beta gamma.';
    const findings = curateSkills([
      doc('skills/a.md', completeSkill('X', body)),
      // Same prose, but not a skill (no type: skill) — must be ignored entirely.
      doc('notes/plain.md', `# Plain\n${body}`),
    ]);
    expect(findings.filter((f) => f.kind === 'duplicate_skill')).toHaveLength(0);
  });
});

describe('curateSkills — stale_skill (opt-in)', () => {
  const now = '2026-07-08T00:00:00Z';

  it('is not computed unless now + modifiedAt are supplied', () => {
    const findings = curateSkills([doc('skills/a.md', completeSkill('A'))]);
    expect(findings.filter((f) => f.kind === 'stale_skill')).toHaveLength(0);
  });

  it('flags a skill unchanged for longer than staleAfterDays', () => {
    const findings = curateSkills([doc('skills/a.md', completeSkill('A'))], {
      now,
      modifiedAt: { 'skills/a.md': '2026-01-01T00:00:00Z' }, // ~188 days old
      staleAfterDays: 60,
    });
    const stale = findings.filter((f) => f.kind === 'stale_skill');
    expect(stale).toHaveLength(1);
    expect(stale[0].paths).toEqual(['skills/a.md']);
  });

  it('does not flag a recently-modified skill, nor one with unknown mtime', () => {
    const findings = curateSkills(
      [
        doc('skills/fresh.md', completeSkill('Fresh')),
        doc('skills/unknown.md', completeSkill('Unknown')),
      ],
      {
        now,
        modifiedAt: { 'skills/fresh.md': '2026-07-01T00:00:00Z' }, // 7 days old
        staleAfterDays: 60,
      },
    );
    expect(findings.filter((f) => f.kind === 'stale_skill')).toHaveLength(0);
  });
});

describe('curateSkills — pinned exemption', () => {
  const now = '2026-07-08T00:00:00Z';
  const pinned = (title: string, body: string) =>
    completeSkill(title, body).replace('type: skill', 'type: skill\npinned: true');

  it('exempts a pinned skill from duplicate_skill and stale_skill', () => {
    const body = 'Configure the widget frobnicator with alpha beta gamma delta.';
    const findings = curateSkills(
      [doc('skills/a.md', pinned('A', body)), doc('skills/b.md', completeSkill('B', body))],
      { now, modifiedAt: { 'skills/a.md': '2026-01-01T00:00:00Z' }, staleAfterDays: 60 },
    );
    // The pair touches a pinned skill → no duplicate finding; pinned skill not stale.
    expect(findings.filter((f) => f.kind === 'duplicate_skill')).toHaveLength(0);
    expect(findings.filter((f) => f.kind === 'stale_skill')).toHaveLength(0);
  });

  it('still flags a pinned skill as incomplete (content edits are allowed)', () => {
    const content = [
      '---',
      'type: skill',
      'pinned: true',
      'name: Locked',
      '---',
      '# Locked',
      'Body.',
    ].join('\n');
    const findings = curateSkills([doc('skills/locked.md', content)]);
    expect(findings.filter((f) => f.kind === 'incomplete')).toHaveLength(1);
  });
});

describe('curateSkills — determinism & scope', () => {
  it('ignores non-skill notes entirely', () => {
    const findings = curateSkills([
      doc('notes/a.md', '# A\nno frontmatter type here'),
      doc('notes/b.md', '---\ntype: note\n---\n# B'),
    ]);
    expect(findings).toEqual([]);
  });

  it('returns a stable order (incomplete → duplicate_skill → stale_skill)', () => {
    const body = 'Configure the widget frobnicator alpha beta gamma delta epsilon.';
    const findings = curateSkills(
      [
        doc('skills/dup1.md', completeSkill('Dup1', body)),
        doc('skills/dup2.md', completeSkill('Dup2', body)),
        doc('skills/bare.md', '---\ntype: skill\n---\n# Bare\nnothing else'),
      ],
      { now: '2026-07-08T00:00:00Z', modifiedAt: { 'skills/bare.md': '2026-01-01T00:00:00Z' } },
    );
    const kinds = findings.map((f) => f.kind);
    // incomplete (bare) comes first, then the duplicate pair, then stale (bare).
    expect(kinds).toEqual(['incomplete', 'duplicate_skill', 'stale_skill']);
  });
});
