/**
 * Supported document formats — the single source of truth for which files the
 * vault lists and reads, shared by the API, the MCP server, and the web app.
 *
 * Markdown (`.md`) is the knowledge format: it is editable and feeds every
 * markdown-only pipeline (frontmatter, wikilinks, backlinks, graph, search,
 * maintenance). HTML (`.html` / `.htm`) is a **read-only presentation format**:
 * it is listed and read verbatim, rendered in an isolated preview, and never
 * enters those pipelines. Anything else is not a vault document.
 */
export type DocumentFormat = 'markdown' | 'html';

const FORMAT_BY_EXTENSION: Readonly<Record<string, DocumentFormat>> = {
  '.md': 'markdown',
  '.html': 'html',
  '.htm': 'html',
};

const MIME_TYPE_BY_FORMAT: Readonly<Record<DocumentFormat, string>> = {
  markdown: 'text/markdown',
  html: 'text/html',
};

/**
 * The document format for a file path, judged by its extension
 * (case-insensitive): `.md` → `markdown`, `.html` / `.htm` → `html`, anything
 * else → `null`. Only the final path segment is considered, so a directory
 * named `site.html/` does not make its children HTML.
 */
export function documentFormatForPath(path: string): DocumentFormat | null {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot === -1) {
    return null;
  }
  return FORMAT_BY_EXTENSION[name.slice(dot).toLowerCase()] ?? null;
}

/** The MIME type a document of this format is served as. */
export function mimeTypeForFormat(format: DocumentFormat): string {
  return MIME_TYPE_BY_FORMAT[format];
}
