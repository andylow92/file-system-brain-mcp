import { useMemo } from 'react';
import { buildSandboxedSrcdoc, HTML_PREVIEW_SANDBOX } from '../html/sandbox';

interface HtmlPaneProps {
  filePath: string | null;
  /** The document's verbatim source; `undefined` while it is still loading. */
  source: string | undefined;
}

function fileName(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

/** Read-only raw source, escaped by React — never parsed or rendered. */
function SourceBlock({ source }: { source: string }) {
  return (
    <pre className="html-source">
      <code>{source}</code>
    </pre>
  );
}

/**
 * Renders a read-only HTML document with its own design, isolated from the app
 * in a sandboxed, opaque-origin frame (see `html/sandbox.ts` for the security
 * model). The document's CSS can never reach the app, and vice versa. If the
 * preview can't be built — or there is nothing to show — the raw source stays
 * available instead.
 */
export function HtmlPreviewPane({ filePath, source }: HtmlPaneProps) {
  const built = useMemo(() => {
    if (!source?.trim()) {
      return { srcdoc: null, error: null };
    }
    try {
      return { srcdoc: buildSandboxedSrcdoc(source), error: null };
    } catch (error: unknown) {
      return { srcdoc: null, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }, [source]);

  if (!filePath) {
    return <p className="empty-state">Select a document to preview.</p>;
  }

  if (source === undefined) {
    return <p className="empty-state">Loading preview…</p>;
  }

  if (!built.srcdoc) {
    return (
      <div className="html-pane">
        <p className="html-pane__notice" role="status">
          {built.error
            ? `This HTML document could not be previewed (${built.error}). Showing its source instead.`
            : 'This HTML document is empty.'}
        </p>
        {source ? <SourceBlock source={source} /> : null}
      </div>
    );
  }

  return (
    <div className="html-pane">
      <p className="html-pane__caption">HTML · read-only · scripts and network disabled</p>
      <iframe
        className="html-preview-frame"
        title={`${fileName(filePath)} — HTML preview`}
        sandbox={HTML_PREVIEW_SANDBOX}
        srcDoc={built.srcdoc}
        referrerPolicy="no-referrer"
      />
    </div>
  );
}

/** The Source tab for an HTML document: its raw text, read-only. */
export function HtmlSourcePane({ filePath, source }: HtmlPaneProps) {
  if (!filePath) {
    return <p className="empty-state">Select a document to view its source.</p>;
  }

  if (source === undefined) {
    return <p className="empty-state">Loading source…</p>;
  }

  return (
    <div className="html-pane">
      <p className="html-pane__caption">HTML source · read-only</p>
      {source ? (
        <SourceBlock source={source} />
      ) : (
        <p className="empty-state">This HTML document is empty.</p>
      )}
    </div>
  );
}
