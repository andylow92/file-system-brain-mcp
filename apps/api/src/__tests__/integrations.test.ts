import { describe, expect, it } from 'vitest';

import {
  buildRunRecordNote,
  maskApiKey,
  redactSecrets,
  ROCKETREACH_INTAKE_QUESTIONS,
  slugifyRun,
  type RocketReachRunRecord,
} from '@repo/shared';

describe('redactSecrets', () => {
  it('redacts every occurrence of a secret', () => {
    const key = 'rr_secret_ABCDEFG';
    const text = `error near ${key} and again ${key}`;
    const out = redactSecrets(text, [key]);
    expect(out).not.toContain(key);
    expect(out).toContain('redacted');
  });

  it('ignores empty or very short secrets so it never blanks unrelated text', () => {
    expect(redactSecrets('hello world', ['', null, undefined, 'ab'])).toBe('hello world');
  });

  it('treats the secret literally (no regex injection)', () => {
    const secret = 'a.b.c.d.e.f';
    expect(redactSecrets('keep a1b2c3d4e5f6 intact', [secret])).toBe('keep a1b2c3d4e5f6 intact');
  });
});

describe('maskApiKey', () => {
  it('masks a long key to a recognizable, unusable hint', () => {
    const masked = maskApiKey('rr_secret_1234567890');
    expect(masked).toBeTruthy();
    expect(masked).not.toBe('rr_secret_1234567890');
    expect(masked).toContain('…');
  });

  it('returns undefined for empty input', () => {
    expect(maskApiKey('')).toBeUndefined();
    expect(maskApiKey(undefined)).toBeUndefined();
    expect(maskApiKey('   ')).toBeUndefined();
  });

  it('fully masks short keys instead of revealing most of their characters', () => {
    // A 4+4 hint on a 9-char key would reveal 8 of 9 characters.
    expect(maskApiKey('123456789')).toBe('•'.repeat(9));
    expect(maskApiKey('12345678901')).toBe('•'.repeat(11));
    expect(maskApiKey('123456789012')).toBe('1234…9012');
  });
});

describe('ROCKETREACH_INTAKE_QUESTIONS', () => {
  it('makes the paid-lookup budget a required question', () => {
    const maxLookups = ROCKETREACH_INTAKE_QUESTIONS.find((q) => q.id === 'maxLookups');
    expect(maxLookups?.required).toBe(true);
  });

  it('asks who to contact', () => {
    const audience = ROCKETREACH_INTAKE_QUESTIONS.find((q) => q.id === 'audience');
    expect(audience).toBeTruthy();
    expect(audience?.required).toBe(true);
  });
});

describe('slugifyRun', () => {
  it('produces filesystem-safe slugs', () => {
    expect(slugifyRun('Q3 Outreach — CTOs!')).toBe('q3-outreach-ctos');
    expect(slugifyRun('   ')).toBe('run');
  });
});

describe('buildRunRecordNote', () => {
  const base: RocketReachRunRecord = {
    generatedAt: '2026-07-21T12:00:00.000Z',
    actor: 'agent:mcp',
    criteria: { audience: 'growth leaders', titles: ['CTO'], requireWorkEmail: true },
    candidates: [
      {
        id: 'p1',
        name: 'Ada Lovelace',
        title: 'CTO',
        company: 'Analytical Engines',
        location: 'London',
      },
    ],
    enriched: [],
    project: 'Q3 outreach',
  };

  it('places the note under prospects/ with a date + slug', () => {
    const note = buildRunRecordNote(base);
    expect(note.path).toBe('prospects/2026-07-21-q3-outreach.md');
  });

  it('records provenance frontmatter and the candidate table', () => {
    const note = buildRunRecordNote(base);
    expect(note.content).toContain('type: prospect-run');
    expect(note.content).toContain('"agent:mcp"');
    expect(note.content).toContain('source: rocketreach');
    expect(note.content).toContain('Ada Lovelace');
    expect(note.content).toContain('candidateCount: 1');
  });

  it('lists enriched contacts with their emails when present', () => {
    const note = buildRunRecordNote({
      ...base,
      enriched: [
        { id: 'p1', name: 'Ada Lovelace', company: 'Analytical Engines', emails: ['ada@ae.com'] },
      ],
    });
    expect(note.content).toContain('## Enriched contacts');
    expect(note.content).toContain('ada@ae.com');
  });

  it('escapes provider-controlled table cells so they cannot break or spoof the note', () => {
    const note = buildRunRecordNote({
      ...base,
      candidates: [
        {
          id: 'p1',
          name: 'Eve | Mallory\nInjected row',
          title: 'CTO | CEO',
          company: 'Pipes & Newlines Inc',
          location: 'Nowhere',
        },
      ],
    });
    // Pipes are escaped and newlines collapsed — one row stays one row.
    expect(note.content).toContain('| Eve \\| Mallory Injected row | CTO \\| CEO |');
    expect(note.content).not.toContain('Eve | Mallory');
  });

  it('only links http(s) profile URLs and encodes link-breaking characters', () => {
    const note = buildRunRecordNote({
      ...base,
      candidates: [
        { id: 'p1', name: 'A', linkedinUrl: 'javascript:alert(1)' },
        { id: 'p2', name: 'B', profileUrl: 'https://example.com/a(b) c' },
      ],
    });
    expect(note.content).not.toContain('javascript:');
    expect(note.content).toContain('[link](https://example.com/a%28b%29%20c)');
  });

  it('records skipped/failed ids so a partial run stays auditable', () => {
    const note = buildRunRecordNote({
      ...base,
      skipped: [
        { id: 'p7', reason: 'over_lookup_limit' },
        { id: 'p8', reason: 'rate_limited' },
      ],
    });
    expect(note.content).toContain('## Skipped / failed');
    expect(note.content).toContain('- p7 — over_lookup_limit');
    expect(note.content).toContain('- p8 — rate_limited');
  });
});
