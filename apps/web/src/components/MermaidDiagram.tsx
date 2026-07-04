import { useEffect, useId, useState } from 'react';

/**
 * Mermaid is a client-only, fairly large library, so it is **dynamically
 * imported** the first time a diagram actually appears — keeping it out of the
 * main and preview bundles for notes that have no diagrams. A single
 * module-level promise memoizes the load + one-time `initialize` across every
 * diagram on the page.
 */
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(({ default: mermaid }) => {
      const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false;
      mermaid.initialize({
        startOnLoad: false,
        theme: prefersDark ? 'dark' : 'default',
        // Diagram source comes from note content (possibly agent-authored), so
        // sanitize it and disallow embedded scripts / click handlers.
        securityLevel: 'strict',
      });
      return mermaid;
    });
  }
  return mermaidPromise;
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
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);

    loadMermaid()
      .then((mermaid) => mermaid.render(renderId, code))
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
  }, [code, renderId]);

  if (svg) {
    return (
      <div
        className="mermaid-diagram"
        role="img"
        aria-label="Mermaid diagram"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
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
