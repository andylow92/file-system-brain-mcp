/**
 * Render-time isolation for read-only HTML documents.
 *
 * The API returns an HTML document's source verbatim; everything that makes it
 * safe to show happens here, in two layers:
 *
 * 1. **Browser-enforced isolation — the security boundary.** The preview is an
 *    `<iframe sandbox="" srcdoc=…>`. The empty sandbox gives the document an
 *    opaque origin (no access to the app's DOM, storage, cookies, or APIs) and
 *    disables scripts, forms, popups, plugins, and top-level navigation. A
 *    restrictive CSP, injected as the first element of `<head>`, blocks every
 *    network load: only inline styles and `data:` images / fonts are allowed.
 * 2. **Light sanitising — UX and defense in depth.** Strip what could never
 *    work anyway (scripts, inline handlers, `javascript:` URLs, `<link>`,
 *    author `<base>`, `meta http-equiv`) and pin link targets so a click can't
 *    navigate the frame: in-page `#fragment` links scroll in place, every other
 *    link becomes a popup the sandbox blocks.
 *
 * Security must never depend on layer 2.
 *
 * Coupling to know about: a `srcdoc` document inherits the embedding page's
 * CSP. The app sets none today; if it ever adds one, that policy must still
 * allow inline styles and `data:` images / fonts, or previews lose their design.
 */

/** CSP for previewed HTML. No `base-uri`: it would also block our own `<base>`. */
export const HTML_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'";

/** The preview frame's sandbox: empty — no `allow-*` token, ever. */
export const HTML_PREVIEW_SANDBOX = '';

const REMOVED_ELEMENTS = new Set(['script', 'base', 'link']);
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'xlink:href']);

/** Browsers ignore whitespace and control characters around/inside a URL scheme. */
function isJavascriptUrl(value: string): boolean {
  const compact = Array.from(value)
    .filter((char) => char > ' ' && char !== '\u007f')
    .join('');
  return compact.toLowerCase().startsWith('javascript:');
}

/**
 * Every element in a parsed document, including those inside `<template>`
 * contents — declarative shadow DOM renders a template's content, so it must
 * be sanitised like the rest of the document.
 */
function collectElements(root: ParentNode): Element[] {
  const elements: Element[] = [];
  for (const element of Array.from(root.querySelectorAll('*'))) {
    elements.push(element);
    if (element.localName === 'template') {
      elements.push(...collectElements((element as HTMLTemplateElement).content));
    }
  }
  return elements;
}

function sanitizeElement(element: Element): void {
  const tag = element.localName;
  if (REMOVED_ELEMENTS.has(tag) || (tag === 'meta' && element.hasAttribute('http-equiv'))) {
    element.remove();
    return;
  }

  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (
      name.startsWith('on') ||
      name === 'ping' ||
      (URL_ATTRIBUTES.has(name) && isJavascriptUrl(attribute.value))
    ) {
      element.removeAttribute(attribute.name);
    }
  }

  if (tag === 'a' || tag === 'area') {
    const href = element.getAttribute('href') ?? element.getAttribute('xlink:href');
    if (href === null) {
      return;
    }
    if (href.trim().startsWith('#')) {
      // In-page fragment: resolved against `about:srcdoc`, so it scrolls in place.
      element.setAttribute('target', '_self');
    } else {
      // Anything else would navigate the frame (and fetch); as a popup it is blocked.
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noopener noreferrer');
    }
  }
}

/**
 * Build the `srcdoc` for a sandboxed HTML preview from a document's raw source.
 * The source is parsed inertly (`DOMParser` never runs scripts or fetches), the
 * light sanitiser runs, and the CSP + `<base>` are prepended to `<head>` —
 * the CSP first, so it governs everything that follows. Styles, structure,
 * classes, `data:` images, and SVG are kept as authored. Fragments without
 * `<html>` / `<head>` work too: the parser synthesises them.
 */
export function buildSandboxedSrcdoc(
  source: string,
  parser: Pick<DOMParser, 'parseFromString'> = new DOMParser(),
): string {
  const doc = parser.parseFromString(source, 'text/html');

  for (const element of collectElements(doc)) {
    sanitizeElement(element);
  }

  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', HTML_PREVIEW_CSP);
  // `about:srcdoc` keeps `#fragment` links in the frame (without it they resolve
  // against the app's URL); `_blank` makes any other link a blocked popup.
  const base = doc.createElement('base');
  base.setAttribute('href', 'about:srcdoc');
  base.setAttribute('target', '_blank');
  const referrer = doc.createElement('meta');
  referrer.setAttribute('name', 'referrer');
  referrer.setAttribute('content', 'no-referrer');
  doc.head.prepend(csp, base, referrer);

  return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
}
