import { isValidElement, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import hljs from 'highlight.js/lib/common';
import { parseNote, resolveWikilink } from '@repo/shared';
import { remarkWikilinks } from '../markdown/remarkWikilinks';
import { BLOCK_ANCHOR_PREFIX, remarkBlockAnchors } from '../markdown/remarkBlockAnchors';
import { MermaidDiagram } from './MermaidDiagram';
import 'highlight.js/styles/github-dark.css';
import 'katex/dist/katex.min.css';

interface MarkdownPreviewPaneProps {
  filePath: string | null;
  markdown: string;
  /** All known logical file paths, used to resolve `[[wikilinks]]`. */
  allPaths?: string[];
  /** Called with the resolved logical path when a wikilink is clicked. */
  onNavigate?: (path: string) => void;
}

const WIKILINK_PREFIX = 'wikilink:';

function nodeToText(children: ReactNode): string {
  if (typeof children === 'string') {
    return children;
  }
  if (Array.isArray(children)) {
    return children.map(nodeToText).join('');
  }
  if (isValidElement(children)) {
    return nodeToText((children.props as { children?: ReactNode }).children);
  }
  return '';
}

/**
 * Copy `value` to the clipboard, falling back to a hidden textarea +
 * `execCommand('copy')` when the async Clipboard API is unavailable (older
 * browsers or insecure contexts). Returns `true` on success.
 */
async function copyToClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'absolute';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    return true;
  } catch {
    return false;
  }
}

/** Checkmark / clipboard icon pair shared by the copy buttons. */
function CopyIcon({ copied }: { copied: boolean }) {
  if (copied) {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M3.5 8.5 6.5 11.5 12.5 5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="5"
        y="5"
        width="8"
        height="9"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M3.5 10.5V3.5A1.5 1.5 0 0 1 5 2h6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface CodeBlockProps {
  value: string;
  language?: string;
}

/**
 * Fenced code block: syntax-highlighted via highlight.js, with a copy button
 * that copies the raw (un-highlighted, un-escaped) source.
 */
function CodeBlock({ value, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const highlighted = useMemo(() => {
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(value, { language }).value;
      }
      return hljs.highlightAuto(value).value;
    } catch {
      return null;
    }
  }, [value, language]);

  async function handleCopy() {
    if (await copyToClipboard(value)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
    // On failure the user can still select-and-copy manually.
  }

  const codeClassName = `hljs${language ? ` language-${language}` : ''}`;

  return (
    <div className="code-block">
      <button
        type="button"
        className={copied ? 'code-copy-btn is-copied' : 'code-copy-btn'}
        onClick={handleCopy}
        aria-label={copied ? 'Copied to clipboard' : 'Copy code to clipboard'}
        title={copied ? 'Copied' : 'Copy'}
      >
        <CopyIcon copied={copied} />
        <span className="code-copy-label">{copied ? 'Copied' : 'Copy'}</span>
      </button>
      <pre>
        {highlighted !== null ? (
          <code className={codeClassName} dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code className={codeClassName}>{value}</code>
        )}
      </pre>
    </div>
  );
}

/**
 * Copies the entire markdown source of the current file to the clipboard,
 * so users don't have to manually select the rendered preview.
 */
function CopyContentButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (await copyToClipboard(value)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  }

  return (
    <button
      type="button"
      className={copied ? 'preview-copy-btn is-copied' : 'preview-copy-btn'}
      onClick={handleCopy}
      aria-label={copied ? 'Copied file content to clipboard' : 'Copy file content to clipboard'}
      title={copied ? 'Copied' : 'Copy file content'}
    >
      <CopyIcon copied={copied} />
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

export function MarkdownPreviewPane({
  filePath,
  markdown,
  allPaths,
  onNavigate,
}: MarkdownPreviewPaneProps) {
  const { body, tags } = useMemo(() => parseNote(markdown), [markdown]);

  const components = useMemo<Components>(
    () => ({
      a({ href, children, title, ...props }) {
        if (href && href.startsWith(WIKILINK_PREFIX)) {
          const target = decodeURIComponent(href.slice(WIKILINK_PREFIX.length));
          const resolved = allPaths ? resolveWikilink(target, allPaths) : null;
          return (
            <a
              className={resolved ? 'wikilink' : 'wikilink wikilink--unresolved'}
              href="#"
              onClick={(event) => {
                event.preventDefault();
                if (resolved && onNavigate) {
                  onNavigate(resolved);
                }
              }}
            >
              {children}
            </a>
          );
        }

        if (href && href.startsWith(BLOCK_ANCHOR_PREFIX)) {
          const blockId = decodeURIComponent(href.slice(BLOCK_ANCHOR_PREFIX.length));
          return (
            <a
              className="block-anchor"
              id={`block-${blockId}`}
              href={`#block-${blockId}`}
              title={title ?? `Block anchor ^${blockId}`}
              aria-label={`Block anchor ${blockId}`}
            >
              {children}
            </a>
          );
        }

        return (
          <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
            {children}
          </a>
        );
      },
      pre({ children }) {
        const codeElement = isValidElement(children) ? children : null;
        const codeProps = (codeElement?.props ?? {}) as {
          className?: string;
          children?: ReactNode;
        };
        const language = /language-(\w+)/.exec(codeProps.className ?? '')?.[1];
        const value = nodeToText(codeProps.children).replace(/\n$/, '');
        // A ```mermaid fence renders as a diagram instead of a code block.
        if (language === 'mermaid') {
          return <MermaidDiagram code={value} />;
        }
        return <CodeBlock value={value} language={language} />;
      },
    }),
    [allPaths, onNavigate],
  );

  if (!filePath) {
    return <p className="empty-state">Select a markdown file to preview.</p>;
  }

  if (!markdown.trim()) {
    return <p className="empty-state">This file has no content yet.</p>;
  }

  return (
    <article className="markdown-preview github-markdown">
      <div className="markdown-preview__toolbar">
        <CopyContentButton value={markdown} />
      </div>
      {tags.length > 0 ? (
        <div className="markdown-preview__tags">
          {tags.map((tag) => (
            <span key={tag} className="tag-chip">
              #{tag}
            </span>
          ))}
        </div>
      ) : null}
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkWikilinks, remarkBlockAnchors]}
        rehypePlugins={[rehypeKatex]}
        components={components}
        urlTransform={(url) =>
          url.startsWith(WIKILINK_PREFIX) || url.startsWith(BLOCK_ANCHOR_PREFIX)
            ? url
            : defaultUrlTransform(url)
        }
      >
        {body}
      </ReactMarkdown>
    </article>
  );
}
