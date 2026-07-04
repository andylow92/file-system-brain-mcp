import { useEffect, useId, useState } from 'react';

/**
 * Mermaid is a client-only, fairly large library, so it is **dynamically
 * imported** the first time a diagram actually appears — keeping it out of the
 * main and preview bundles for notes that have no diagrams. A single
 * module-level promise memoizes the load across every diagram on the page.
 * Theme is applied per render (see below), not here, so it can react to a live
 * color-scheme change without re-importing the library.
 */
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(({ default: mermaid }) => mermaid);
  }
  return mermaidPromise;
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Track `prefers-color-scheme: dark` **reactively**, so a diagram re-themes when
 * the user toggles their OS/browser theme (the rest of the app already follows
 * the scheme live via CSS). Falls back to `false` where `matchMedia` is absent
 * (e.g. jsdom in tests).
 */
function usePrefersDark(): boolean {
  const [prefersDark, setPrefersDark] = useState(
    () => window.matchMedia?.(DARK_QUERY)?.matches ?? false,
  );

  useEffect(() => {
    const media = window.matchMedia?.(DARK_QUERY);
    if (!media) {
      return;
    }
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return prefersDark;
}

interface MermaidDiagramProps {
  /** The raw mermaid diagram source — the body of a fenced ` ```mermaid ` block. */
  code: string;
}

/**
 * Render a fenced ` ```mermaid ` code block as an SVG diagram. Mermaid loads
 * lazily and renders asynchronously; while it loads — and if the diagram is
 * invalid — the raw source is shown in a `<pre>`, so a diagram never blanks the
 * preview and always degrades to legible text.
 */
export function MermaidDiagram({ code }: MermaidDiagramProps) {
  // Mermaid needs a DOM-id-safe, unique id; React's useId can emit ':' which is
  // not valid in the querySelector mermaid runs internally, so strip it.
  const renderId = `mermaid-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;
  const prefersDark = usePrefersDark();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);

    loadMermaid()
      .then((mermaid) => {
        // Re-`initialize` per render so a theme toggle takes effect. It is
        // cheap and idempotent; the heavy library load stays memoized above.
        // Diagram source comes from note content (possibly agent-authored), so
        // sanitize it and disallow embedded scripts / click handlers.
        mermaid.initialize({
          startOnLoad: false,
          theme: prefersDark ? 'dark' : 'default',
          securityLevel: 'strict',
        });
        return mermaid.render(renderId, code);
      })
      .then(({ svg: rendered }) => {
        if (!cancelled) {
          setSvg(rendered);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [code, renderId, prefersDark]);

  if (svg) {
    // No `role="img"` / `aria-label` wrapper: mermaid renders node/edge labels
    // as real `<text>` in the SVG, and marking the subtree as a single image
    // would hide all of it from assistive tech. Let the SVG's own text be read.
    return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
  }

  // Loading, or failed to render → keep the source visible (with an error note
  // on failure) so nothing is ever lost.
  return (
    <div
      className={`mermaid-diagram ${failed ? 'mermaid-diagram--error' : 'mermaid-diagram--pending'}`}
    >
      {failed ? (
        <p className="mermaid-diagram__error">
          Couldn’t render this Mermaid diagram — showing its source:
        </p>
      ) : null}
      <pre className="mermaid-diagram__source">
        <code>{code}</code>
      </pre>
    </div>
  );
}
