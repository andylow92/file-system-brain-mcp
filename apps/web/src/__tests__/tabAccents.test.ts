import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the viewer-tab accent tokens (`--color-tab-*` in styles.css): each must
 * meet WCAG 1.4.11 non-text contrast (≥ 3:1) against the surface the tab bar
 * actually sits on, in both themes, and the set must stay clearly distinct.
 */
const css = readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

const TAB_KEYS = ['preview', 'source', 'split', 'edit', 'activity', 'review', 'graph'];

/** The body of the first `{ … }` block opened at `start` (no nested braces inside). */
function blockAt(text: string, start: number): string {
  const open = text.indexOf('{', start);
  const close = text.indexOf('}', open);
  return text.slice(open + 1, close);
}

function ruleBody(selector: string): string {
  const index = css.indexOf(`\n${selector} {`);
  expect(index, `rule ${selector}`).toBeGreaterThan(-1);
  return blockAt(css, index);
}

function tokens(block: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of block.matchAll(/(--color-[a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    found[match[1]] = match[2].toLowerCase();
  }
  return found;
}

const darkTokens = tokens(blockAt(css, css.indexOf('\n:root {')));
const lightMedia = css.indexOf('@media (prefers-color-scheme: light)');
const lightTokens = tokens(blockAt(css, css.indexOf(':root {', lightMedia)));

function channels(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}

function linear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** OKLab coordinates — perceptual distance between accents. */
function oklab(hex: string): number[] {
  const [r, g, b] = channels(hex).map(linear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817104123 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function distance(a: string, b: string): number {
  const [pa, pb] = [oklab(a), oklab(b)];
  return Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
}

describe('viewer tab accents', () => {
  it('sit on --color-bg: the layout paints it and nothing above it repaints', () => {
    expect(ruleBody('.layout')).toMatch(/background:\s*var\(--color-bg\)/);
    expect(ruleBody('.right-panel')).toMatch(/background:\s*transparent/);
    expect(ruleBody('.viewer-region')).not.toMatch(/background/);
    expect(ruleBody('.tabs')).not.toMatch(/background/);
  });

  for (const [theme, themeTokens] of [
    ['dark', darkTokens],
    ['light', lightTokens],
  ] as const) {
    describe(`${theme} theme`, () => {
      const background = themeTokens['--color-bg'];
      const accents = TAB_KEYS.map((key) => [key, themeTokens[`--color-tab-${key}`]] as const);

      it('defines a plain-hex accent for every viewer tab', () => {
        expect(background).toMatch(/^#[0-9a-f]{6}$/);
        for (const [key, value] of accents) {
          expect(value, `--color-tab-${key}`).toMatch(/^#[0-9a-f]{6}$/);
        }
      });

      it('gives every accent ≥ 3:1 non-text contrast against the tab bar', () => {
        for (const [key, value] of accents) {
          expect(contrast(value, background), `${key} ${value} on ${background}`).toBeGreaterThan(
            3,
          );
        }
      });

      it('keeps the accents pairwise distinct', () => {
        for (let i = 0; i < accents.length; i += 1) {
          for (let j = i + 1; j < accents.length; j += 1) {
            const [a, b] = [accents[i], accents[j]];
            expect(a[1], `${a[0]} vs ${b[0]}`).not.toBe(b[1]);
            // ~5× the OKLab just-noticeable difference (≈ 0.02).
            expect(distance(a[1], b[1]), `${a[0]} vs ${b[0]}`).toBeGreaterThanOrEqual(0.1);
          }
        }
      });
    });
  }

  it('maps each data-tab to its token and spends accents only on the indicator', () => {
    for (const key of TAB_KEYS) {
      expect(ruleBody(`.tab[data-tab='${key}']`)).toMatch(
        new RegExp(`--tab-accent:\\s*var\\(--color-tab-${key}\\)`),
      );
    }
    expect(ruleBody('.tab[data-tab].active')).toMatch(/border-bottom-color:\s*var\(--tab-accent/);
    // Never label text or a surface: no `color:` / `background` takes an accent.
    expect(css).not.toMatch(/(^|[\s;{])color:\s*var\(--(tab-accent|color-tab-)/m);
    expect(css).not.toMatch(/background[a-z-]*:[^;]*var\(--(tab-accent|color-tab-)/);
  });
});
