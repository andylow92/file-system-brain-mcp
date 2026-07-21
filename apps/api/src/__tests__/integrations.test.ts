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
});
