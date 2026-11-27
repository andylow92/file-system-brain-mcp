/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Read from disk: vitest stubs out every CSS import (`?raw` included).
const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8');

/**
 * jsdom applies no `@media` queries, so a stylesheet bug that only shows at
 * some viewport widths slips past every component test. This resolves
 * `display` for an element straight from styles.css: the rules that target it
 * by one of its classes alone (all of equal specificity, so the last one that
 * applies wins), with `min-width` / `max-width` queries evaluated for the given
 * viewport and every other media feature treated as not matching.
 *
 * It guards a real regression: an unconditional `display: none` placed after
 * the 900px query hid the sidebar trigger at every width, so the file tree
 * could not be opened on phones or tablets.
 */
function resolveDisplay(classNames: string[], viewportWidth: number): string | undefined {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);

  try {
    const selectors = new Set(classNames.map((name) => `.${name}`));
    let display: string | undefined;

    const visit = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSMediaRule) {
          if (widthQueryMatches(rule.media.mediaText, viewportWidth)) visit(rule.cssRules);
        } else if (rule instanceof CSSStyleRule) {
          const value = rule.style.getPropertyValue('display');
          if (value && rule.selectorText.split(',').some((s) => selectors.has(s.trim()))) {
            display = value;
          }
        }
      }
    };

    visit(style.sheet!.cssRules);
    return display;
  } finally {
    style.remove();
  }
}

function widthQueryMatches(mediaText: string, viewportWidth: number): boolean {
  const features = [...mediaText.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)];
  if (features.length === 0) return false;
  return features.every(([, bound, px]) =>
    bound === 'max' ? viewportWidth <= Number(px) : viewportWidth >= Number(px),
  );
}

describe('mobile sidebar chrome in styles.css', () => {
  // The trigger is also an .icon-btn, whose own `display` must not leak
  // through on desktop.
  const trigger = ['icon-btn', 'mobile-sidebar-trigger'];
  const backdrop = ['sidebar-backdrop'];

  it.each([320, 390, 768, 900])('shows the sidebar trigger at %ipx', (width) => {
    expect(resolveDisplay(trigger, width)).toBe('inline-flex');
  });

  it.each([901, 1280])('hides the sidebar trigger at %ipx', (width) => {
    expect(resolveDisplay(trigger, width)).toBe('none');
  });

  // The backdrop is only rendered while the drawer is open (GlobalLayout); the
  // stylesheet decides whether that open drawer is a mobile overlay at all.
  it.each([390, 900])('lets the open-drawer backdrop show at %ipx', (width) => {
    expect(resolveDisplay(backdrop, width)).toBe('block');
  });

  it.each([901, 1280])('hides the backdrop at %ipx', (width) => {
    expect(resolveDisplay(backdrop, width)).toBe('none');
  });
});
