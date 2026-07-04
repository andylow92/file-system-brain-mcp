import { describe, expect, it } from 'vitest';

import {
  extractTags,
  extractWikilinks,
  parseFrontmatter,
  parseNote,
  parseWikilinkToken,
  resolveWikilink,
  splitFrontmatter,
} from '@repo/shared';

describe('parseWikilinkToken', () => {
  it('parses a plain target', () => {
    expect(parseWikilinkToken('Note')).toEqual({ raw: 'Note', target: 'Note' });
  });

  it('parses target with heading and alias', () => {
    expect(parseWikilinkToken('folder/Note#Section|Display')).toEqual({
      raw: 'folder/Note#Section|Display',
      target: 'folder/Note',
      heading: 'Section',
      alias: 'Display',
    });
  });

  it('treats a `rel:` alias as a typed relation, not a display alias', () => {
    expect(parseWikilinkToken('Target|rel:supports')).toEqual({
      raw: 'Target|rel:supports',
      target: 'Target',
      type: 'supports',
    });
  });

  it('still treats non-`rel:` aliases as display names', () => {
    expect(parseWikilinkToken('Target|My display')).toEqual({
      raw: 'Target|My display',
      target: 'Target',
      alias: 'My display',
    });
  });
});

describe('parseFrontmatter', () => {
  it('returns the raw body when there is no frontmatter', () => {
    const result = parseFrontmatter('# Title\n\nBody');
    expect(result.hasFrontmatter).toBe(false);
    expect(result.body).toBe('# Title\n\nBody');
    expect(result.frontmatter).toEqual({});
  });

  it('parses scalars, inline arrays, and block lists', () => {
    const raw = [
      '---',
      'title: Hello World',
      'tags: [alpha, beta]',
      'aliases:',
      '  - one',
      '  - two',
      '---',
      'Body text',
    ].join('\n');

    const result = parseFrontmatter(raw);
    expect(result.hasFrontmatter).toBe(true);
    expect(result.frontmatter).toEqual({
      title: 'Hello World',
      tags: ['alpha', 'beta'],
      aliases: ['one', 'two'],
    });
    expect(result.body).toBe('Body text');
  });

  it('treats an unterminated fence as plain body', () => {
    const raw = '---\ntitle: x\nstill going';
    const result = parseFrontmatter(raw);
    expect(result.hasFrontmatter).toBe(false);
    expect(result.body).toBe(raw);
  });
});

describe('splitFrontmatter', () => {
  it('returns null when there is no opening fence', () => {
    expect(splitFrontmatter('# Title\n\nBody')).toBeNull();
  });

  it('returns null for an unterminated fence', () => {
    expect(splitFrontmatter('---\ntitle: x\nstill going')).toBeNull();
  });

  it('returns the raw inner lines and the trimmed body', () => {
    const raw = ['---', 'title: Hello', 'related: [[Foo]]', '---', '', 'Body text'].join('\n');
    expect(splitFrontmatter(raw)).toEqual({
      lines: ['title: Hello', 'related: [[Foo]]'],
      body: 'Body text',
    });
  });
});

describe('extractWikilinks', () => {
  it('extracts links and ignores those inside code', () => {
    const raw = 'See [[Alpha]] and [[b/Beta|B]].\n\n```\n[[NotALink]]\n```\n`[[AlsoNot]]`';
    const links = extractWikilinks(raw);
    expect(links.map((link) => link.target)).toEqual(['Alpha', 'b/Beta']);
    expect(links[1].alias).toBe('B');
  });
});

describe('extractTags', () => {
  it('merges frontmatter tags with inline tags and de-dupes', () => {
    const raw = ['---', 'tags: [project, idea]', '---', 'Body #idea #todo/now'].join('\n');
    expect(extractTags(raw)).toEqual(['project', 'idea', 'todo/now']);
  });

  it('does not treat markdown headings as tags', () => {
    expect(extractTags('# Heading\n## Sub')).toEqual([]);
  });
});

describe('parseNote', () => {
  it('returns frontmatter, body, tags, and links together', () => {
    const raw = ['---', 'title: T', '---', 'Hello [[World]] #note'].join('\n');
    const note = parseNote(raw);
    expect(note.frontmatter).toEqual({ title: 'T' });
    expect(note.body).toBe('Hello [[World]] #note');
    expect(note.tags).toEqual(['note']);
    expect(note.links.map((link) => link.target)).toEqual(['World']);
  });
});

describe('resolveWikilink', () => {
  const paths = ['notes/Alpha.md', 'notes/sub/Beta.md', 'Gamma.md'];

  it('resolves by basename', () => {
    expect(resolveWikilink('Alpha', paths)).toBe('notes/Alpha.md');
    expect(resolveWikilink('Beta', paths)).toBe('notes/sub/Beta.md');
  });

  it('resolves by full path with or without extension', () => {
    expect(resolveWikilink('notes/Alpha', paths)).toBe('notes/Alpha.md');
    expect(resolveWikilink('Gamma.md', paths)).toBe('Gamma.md');
  });

  it('is case-insensitive and returns null when unresolved', () => {
    expect(resolveWikilink('alpha', paths)).toBe('notes/Alpha.md');
    expect(resolveWikilink('Missing', paths)).toBeNull();
  });
});
