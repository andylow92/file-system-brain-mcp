import { describe, expect, it } from 'vitest';
import { buildSandboxedSrcdoc, HTML_PREVIEW_CSP, HTML_PREVIEW_SANDBOX } from '../sandbox';

/** Build the srcdoc, then parse it back so assertions read the real output. */
function build(source: string): { srcdoc: string; doc: Document } {
  const srcdoc = buildSandboxedSrcdoc(source);
  return { srcdoc, doc: new DOMParser().parseFromString(srcdoc, 'text/html') };
}

describe('HTML preview policy', () => {
  it('uses an empty sandbox and a no-network CSP', () => {
    expect(HTML_PREVIEW_SANDBOX).toBe('');
    expect(HTML_PREVIEW_CSP).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'",
    );
    // `base-uri` would also block our own injected <base>.
    expect(HTML_PREVIEW_CSP).not.toContain('base-uri');
  });
});

describe('buildSandboxedSrcdoc', () => {
  it('prepends the CSP meta first and the srcdoc base second', () => {
    const { srcdoc, doc } = build(
      '<!DOCTYPE html><html><head><title>Report</title><style>h1{color:red}</style></head><body><h1>Hi</h1></body></html>',
    );

    expect(srcdoc.startsWith('<!DOCTYPE html><html>')).toBe(true);
    const [csp, base, referrer, ...rest] = Array.from(doc.head.children);
    expect(csp.localName).toBe('meta');
    expect(csp.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(csp.getAttribute('content')).toBe(HTML_PREVIEW_CSP);
    expect(base.localName).toBe('base');
    expect(base.getAttribute('href')).toBe('about:srcdoc');
    expect(base.getAttribute('target')).toBe('_blank');
    expect(referrer.getAttribute('name')).toBe('referrer');
    expect(referrer.getAttribute('content')).toBe('no-referrer');
    expect(rest.map((element) => element.localName)).toEqual(['title', 'style']);
    expect(doc.querySelectorAll('meta[http-equiv]')).toHaveLength(1);
    expect(doc.querySelectorAll('base')).toHaveLength(1);
  });

  it('strips scripts, author base, links, http-equiv metas, handlers, and ping', () => {
    const { doc } = build(
      [
        '<html><head>',
        '<base href="https://evil.example/">',
        '<link rel="stylesheet" href="/x.css"><link rel="prefetch" href="/x"><link rel="icon" href="/i">',
        '<meta http-equiv="refresh" content="0;url=/x"><meta http-equiv="Set-Cookie" content="a=b">',
        '<meta name="color-scheme" content="light dark">',
        '<script>fetch("/api/tree")</script>',
        '</head><body onload="alert(1)">',
        '<img src="x" onerror="alert(2)" alt="pic">',
        '<svg onload="alert(3)"><script>alert(4)</script><circle r="2" onclick="x()"/></svg>',
        '<a id="p" href="#s" ping="/track">p</a>',
        '<meta http-equiv="refresh" content="0;url=/late">',
        '</body></html>',
      ].join(''),
    );

    expect(doc.querySelectorAll('script')).toHaveLength(0);
    expect(doc.querySelectorAll('link')).toHaveLength(0);
    expect(doc.querySelectorAll('base')).toHaveLength(1); // only ours
    expect(doc.querySelector('base')?.getAttribute('href')).toBe('about:srcdoc');
    // Only our CSP meta keeps http-equiv; non-http-equiv metas are kept.
    expect(
      Array.from(doc.querySelectorAll('meta[http-equiv]')).map((m) => m.getAttribute('content')),
    ).toEqual([HTML_PREVIEW_CSP]);
    expect(doc.querySelector('meta[name="color-scheme"]')).not.toBeNull();
    const withHandlers = Array.from(doc.querySelectorAll('*')).filter((element) =>
      Array.from(element.attributes).some((attribute) => attribute.name.startsWith('on')),
    );
    expect(withHandlers).toEqual([]);
    expect(doc.getElementById('p')?.hasAttribute('ping')).toBe(false);
    expect(doc.querySelector('img')?.getAttribute('alt')).toBe('pic');
  });

  it('drops javascript: URLs in every URL attribute, however they are spelled', () => {
    const { doc } = build(
      [
        '<a id="a1" href="javascript:alert(1)">1</a>',
        '<a id="a2" href="  JaVaScRiPt:alert(2)">2</a>',
        '<a id="a3" href="java\tscript:alert(3)">3</a>',
        '<a id="a4" href="\u0001javascript:alert(4)">4</a>',
        '<iframe id="f" src="javascript:alert(5)"></iframe>',
        '<form id="form" action="javascript:alert(6)"><button id="b" formaction="javascript:alert(7)">go</button></form>',
        '<svg><a id="s" xlink:href="javascript:alert(8)"><text>s</text></a></svg>',
        '<a id="ok" href="https://example.com/javascript:not-a-scheme">ok</a>',
      ].join(''),
    );

    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      expect(doc.getElementById(id)?.hasAttribute('href'), id).toBe(false);
    }
    expect(doc.getElementById('f')?.hasAttribute('src')).toBe(false);
    expect(doc.getElementById('form')?.hasAttribute('action')).toBe(false);
    expect(doc.getElementById('b')?.hasAttribute('formaction')).toBe(false);
    expect(doc.getElementById('s')?.hasAttribute('xlink:href')).toBe(false);
    expect(doc.getElementById('ok')?.getAttribute('href')).toBe(
      'https://example.com/javascript:not-a-scheme',
    );
  });

  it('keeps fragment links in place and turns every other link into a blocked popup', () => {
    const { doc } = build(
      [
        '<a id="frag" href="#section">frag</a>',
        '<a id="frag-top" href="  #top" target="_top">frag top</a>',
        '<a id="self" href="/x" target="_self">self</a>',
        '<a id="top" href="/x" target="_top">top</a>',
        '<a id="parent" href="/x" target="_parent">parent</a>',
        '<a id="none" href="other.html">relative</a>',
        '<a id="ext" href="https://example.com/">external</a>',
        '<a id="empty" href="">empty</a>',
        '<a id="no-href">anchor without href</a>',
        '<map name="m"><area id="area" href="/x" shape="rect" coords="0,0,1,1" alt="a"></map>',
        '<svg><a id="svg" href="/x"><text>svg</text></a></svg>',
      ].join(''),
    );

    expect(doc.getElementById('frag')?.getAttribute('target')).toBe('_self');
    expect(doc.getElementById('frag-top')?.getAttribute('target')).toBe('_self');
    for (const id of ['self', 'top', 'parent', 'none', 'ext', 'empty', 'area', 'svg']) {
      const link = doc.getElementById(id);
      expect(link?.getAttribute('target'), id).toBe('_blank');
      expect(link?.getAttribute('rel'), id).toBe('noopener noreferrer');
    }
    expect(doc.getElementById('ext')?.getAttribute('href')).toBe('https://example.com/');
    expect(doc.getElementById('no-href')?.hasAttribute('target')).toBe(false);
  });

  it('keeps the document design: styles, inline styles, classes, text, data images, svg', () => {
    const { doc } = build(
      [
        '<html lang="fr" style="background:#101820"><head>',
        '<style>@font-face{font-family:R;src:url(data:font/woff2;base64,AA==)} .card{color:#f4c430}</style>',
        '</head><body class="report">',
        '<div class="card" style="padding:2rem">Résumé Q3</div>',
        '<img alt="dot" src="data:image/png;base64,iVBORw0KGgo=">',
        '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="teal"/></svg>',
        '<form><input name="q"></form>',
        '</body></html>',
      ].join(''),
    );

    expect(doc.documentElement.getAttribute('lang')).toBe('fr');
    expect(doc.documentElement.getAttribute('style')).toBe('background:#101820');
    expect(doc.querySelector('style')?.textContent).toContain('.card{color:#f4c430}');
    expect(doc.body.className).toBe('report');
    expect(doc.querySelector('.card')?.getAttribute('style')).toBe('padding:2rem');
    expect(doc.querySelector('.card')?.textContent).toBe('Résumé Q3');
    expect(doc.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    );
    expect(doc.querySelector('svg rect')?.getAttribute('fill')).toBe('teal');
    expect(doc.querySelector('input')).not.toBeNull();
  });

  it('works for fragments without <html> or <head>', () => {
    const { srcdoc, doc } = build('<h1>Just a fragment</h1><p>text</p>');

    expect(srcdoc.startsWith('<!DOCTYPE html><html><head><meta http-equiv=')).toBe(true);
    expect(doc.head.firstElementChild?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(doc.querySelector('h1')?.textContent).toBe('Just a fragment');
  });

  it('sanitises template contents too (declarative shadow DOM renders them)', () => {
    const { doc } = build(
      '<div><template shadowrootmode="open"><a id="t" href="https://example.com/" target="_self">x</a><img src="x" onerror="alert(1)"><script>alert(2)</script><template><a id="deep" href="/y">y</a></template></template></div>',
    );

    const content = doc.querySelector('template')!.content;
    const link = content.getElementById('t');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(content.querySelector('img')?.hasAttribute('onerror')).toBe(false);
    expect(content.querySelectorAll('script')).toHaveLength(0);
    const deep = content.querySelector('template')!.content.getElementById('deep');
    expect(deep?.getAttribute('target')).toBe('_blank');
  });
});
