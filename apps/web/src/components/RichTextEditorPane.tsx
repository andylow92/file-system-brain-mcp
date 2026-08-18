import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { fixMarkdownFormat, OpenRouterError } from '../openrouter/client';
import {
  DEFAULT_OPENROUTER_MODEL,
  loadOpenRouterApiKey,
  loadOpenRouterModel,
  subscribeToOpenRouterSettings,
} from '../openrouter/storage';
import { FixFormatPreviewDialog } from './FixFormatPreviewDialog';
import { SettingsDialog } from './SettingsDialog';

interface RichTextEditorPaneProps {
  filePath: string | null;
  markdown: string;
  savedMarkdown: string;
  isDirty: boolean;
  onChangeMarkdown: (markdown: string) => void;
  onSave: () => void;
}

type WrapFormat = 'bold' | 'italic' | 'code' | 'link';
type LineFormat = 'heading1' | 'heading2' | 'bullet' | 'quote';
type BlockFormat = 'codeblock';

const wrapSyntax: Record<WrapFormat, { prefix: string; suffix: string; placeholder: string }> = {
  bold: { prefix: '**', suffix: '**', placeholder: 'bold text' },
  italic: { prefix: '*', suffix: '*', placeholder: 'italic text' },
  code: { prefix: '`', suffix: '`', placeholder: 'code' },
  link: { prefix: '[', suffix: '](https://)', placeholder: 'link text' },
};

const linePrefix: Record<LineFormat, string> = {
  heading1: '# ',
  heading2: '## ',
  bullet: '- ',
  quote: '> ',
};

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function RichTextEditorPane({
  filePath,
  markdown,
  savedMarkdown,
  isDirty,
  onChangeMarkdown,
  onSave,
}: RichTextEditorPaneProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [value, setValue] = useState(markdown);
  const [apiKey, setApiKey] = useState(() => loadOpenRouterApiKey());
  const [model, setModel] = useState(() => loadOpenRouterModel());
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isFixing, setIsFixing] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);
  const [proposedMarkdown, setProposedMarkdown] = useState<string | null>(null);
  const fixAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setValue(markdown);
  }, [filePath, markdown]);

  // The same settings are editable from the topbar Settings dialog, so listen
  // for writes from anywhere rather than trusting our own snapshot.
  useEffect(() => {
    return subscribeToOpenRouterSettings((next) => {
      setApiKey(next.apiKey);
      setModel(next.model);
    });
  }, []);

  useEffect(() => {
    return () => {
      fixAbortRef.current?.abort();
    };
  }, []);

  const commitChange = useCallback(
    (nextValue: string) => {
      setValue(nextValue);
      onChangeMarkdown(nextValue);
    },
    [onChangeMarkdown],
  );

  const applyWrap = useCallback(
    (format: WrapFormat) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const { selectionStart, selectionEnd } = textarea;
      const { prefix, suffix, placeholder } = wrapSyntax[format];
      const current = textarea.value;
      const selected = current.slice(selectionStart, selectionEnd) || placeholder;
      const next =
        current.slice(0, selectionStart) + prefix + selected + suffix + current.slice(selectionEnd);

      commitChange(next);

      const caretStart = selectionStart + prefix.length;
      const caretEnd = caretStart + selected.length;
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(caretStart, caretEnd);
      });
    },
    [commitChange],
  );

  const applyLine = useCallback(
    (format: LineFormat) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const { selectionStart, selectionEnd } = textarea;
      const current = textarea.value;
      const lineStart = current.lastIndexOf('\n', Math.max(selectionStart - 1, 0)) + 1;
      const rawLineEnd = current.indexOf('\n', selectionEnd);
      const lineEnd = rawLineEnd === -1 ? current.length : rawLineEnd;

      const prefix = linePrefix[format];
      const block = current.slice(lineStart, lineEnd);
      const transformed = block
        .split('\n')
        .map((line) => {
          const stripped = line.replace(/^(#{1,6}\s|-\s|>\s)/, '');
          return prefix + stripped;
        })
        .join('\n');

      const next = current.slice(0, lineStart) + transformed + current.slice(lineEnd);
      commitChange(next);

      const delta = transformed.length - block.length;
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(selectionStart + prefix.length, selectionEnd + delta);
      });
    },
    [commitChange],
  );

  const applyBlock = useCallback(
    (format: BlockFormat) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const { selectionStart, selectionEnd } = textarea;
      const current = textarea.value;
      const selected = current.slice(selectionStart, selectionEnd) || 'code here';

      const opening = format === 'codeblock' ? '```\n' : '';
      const closing = format === 'codeblock' ? '\n```' : '';
      const next =
        current.slice(0, selectionStart) +
        opening +
        selected +
        closing +
        current.slice(selectionEnd);

      commitChange(next);

      const caretStart = selectionStart + opening.length;
      const caretEnd = caretStart + selected.length;
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(caretStart, caretEnd);
      });
    },
    [commitChange],
  );

  // The panel has already persisted and broadcast the new settings; all that is
  // left is to dismiss the dialog the user opened from this toolbar.
  const handleSaveSettings = useCallback(() => {
    setIsSettingsOpen(false);
    setFixError(null);
  }, []);

  const handleFixFormat = useCallback(async () => {
    if (isFixing) {
      return;
    }
    if (!apiKey) {
      setFixError('Add your OpenRouter API key to use Fix Format.');
      setIsSettingsOpen(true);
      return;
    }
    if (!value.trim()) {
      setFixError('Nothing to format yet — write some markdown first.');
      return;
    }

    fixAbortRef.current?.abort();
    const controller = new AbortController();
    fixAbortRef.current = controller;

    setFixError(null);
    setIsFixing(true);
    try {
      const result = await fixMarkdownFormat({
        apiKey,
        model: model || DEFAULT_OPENROUTER_MODEL,
        markdown: value,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        return;
      }
      setProposedMarkdown(result);
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      if (error instanceof OpenRouterError) {
        setFixError(error.message);
      } else if (error instanceof Error) {
        setFixError(error.message);
      } else {
        setFixError('Fix Format failed for an unknown reason.');
      }
    } finally {
      if (fixAbortRef.current === controller) {
        fixAbortRef.current = null;
      }
      setIsFixing(false);
    }
  }, [apiKey, isFixing, model, value]);

  const handleAcceptProposed = useCallback(() => {
    if (proposedMarkdown == null) {
      return;
    }
    commitChange(proposedMarkdown);
    setProposedMarkdown(null);
  }, [commitChange, proposedMarkdown]);

  const handleRejectProposed = useCallback(() => {
    setProposedMarkdown(null);
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const isMod = event.metaKey || event.ctrlKey;
    if (!isMod) return;

    const key = event.key.toLowerCase();
    if (key === 'b') {
      event.preventDefault();
      applyWrap('bold');
    } else if (key === 'i') {
      event.preventDefault();
      applyWrap('italic');
    } else if (key === 'k') {
      event.preventDefault();
      applyWrap('link');
    } else if (key === 'e') {
      event.preventDefault();
      applyWrap('code');
    }
  }

  const stats = useMemo(() => {
    return {
      words: countWords(value),
      chars: value.length,
      lines: value ? value.split('\n').length : 0,
    };
  }, [value]);

  if (!filePath) {
    return <p className="empty-state">Select a markdown file to edit.</p>;
  }

  return (
    <div className="editor-pane">
      <header className="editor-header">
        <div>
          <div className="editor-title">{filePath}</div>
          <p className={isDirty ? 'editor-meta is-dirty' : 'editor-meta'}>
            {isDirty ? 'Unsaved changes' : 'All changes saved'}
          </p>
        </div>
        <button type="button" onClick={onSave} disabled={!isDirty} className="save-button">
          Save
        </button>
      </header>

      <div className="editor-surface" role="group" aria-label="Markdown editor">
        <div className="editor-toolbar" role="toolbar" aria-label="Formatting">
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => applyLine('heading1')}
            title="Heading 1"
            aria-label="Heading 1"
          >
            H1
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => applyLine('heading2')}
            title="Heading 2"
            aria-label="Heading 2"
          >
            H2
          </button>
          <span className="toolbar-sep" aria-hidden="true" />
          <button
            type="button"
            className="toolbar-btn bold"
            onClick={() => applyWrap('bold')}
            title="Bold (⌘B)"
            aria-label="Bold"
          >
            B
          </button>
          <button
            type="button"
            className="toolbar-btn italic"
            onClick={() => applyWrap('italic')}
            title="Italic (⌘I)"
            aria-label="Italic"
          >
            I
          </button>
          <button
            type="button"
            className="toolbar-btn mono"
            onClick={() => applyWrap('code')}
            title="Inline code (⌘E)"
            aria-label="Inline code"
          >
            {'</>'}
          </button>
          <span className="toolbar-sep" aria-hidden="true" />
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => applyLine('bullet')}
            title="Bulleted list"
            aria-label="Bulleted list"
          >
            List
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => applyLine('quote')}
            title="Quote"
            aria-label="Quote"
          >
            Quote
          </button>
          <button
            type="button"
            className="toolbar-btn mono"
            onClick={() => applyBlock('codeblock')}
            title="Code block"
            aria-label="Code block"
          >
            {'{ }'}
          </button>
          <span className="toolbar-sep" aria-hidden="true" />
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => applyWrap('link')}
            title="Link (⌘K)"
            aria-label="Link"
          >
            ↗
          </button>
          <span className="toolbar-spacer" aria-hidden="true" />
          <button
            type="button"
            className="toolbar-btn fix-format-btn"
            onClick={() => {
              void handleFixFormat();
            }}
            disabled={isFixing}
            title={
              apiKey
                ? `Fix format with ${model || DEFAULT_OPENROUTER_MODEL}`
                : 'Fix format (add OpenRouter API key first)'
            }
            aria-label="Fix format with OpenRouter"
          >
            {isFixing ? 'Formatting…' : 'Fix format'}
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => setIsSettingsOpen(true)}
            title="OpenRouter settings"
            aria-label="OpenRouter settings"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" width="14" height="14">
              <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path
                d="M8 1.5v1.7M8 12.8v1.7M1.5 8h1.7M12.8 8h1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M3.4 12.6l1.2-1.2M11.4 4.6l1.2-1.2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {fixError ? (
          <p className="fix-format-error" role="alert">
            {fixError}
          </p>
        ) : null}

        <textarea
          ref={textareaRef}
          className="markdown-textarea"
          aria-label="Markdown source"
          value={value}
          spellCheck
          placeholder="# Start writing…"
          onKeyDown={handleKeyDown}
          onChange={(event) => commitChange(event.target.value)}
        />

        <div className="editor-footer" aria-live="off">
          <span>
            {stats.words} {stats.words === 1 ? 'word' : 'words'} · {stats.chars}{' '}
            {stats.chars === 1 ? 'char' : 'chars'} · {stats.lines}{' '}
            {stats.lines === 1 ? 'line' : 'lines'}
          </span>
          <span>markdown</span>
        </div>
      </div>

      {!savedMarkdown.trim() && !isDirty ? (
        <p className="empty-state">This file is empty. Start writing to add content.</p>
      ) : null}

      <SettingsDialog
        open={isSettingsOpen}
        initialSection="openrouter"
        onClose={() => setIsSettingsOpen(false)}
        onOpenRouterSaved={handleSaveSettings}
      />

      <FixFormatPreviewDialog
        open={proposedMarkdown !== null}
        filePath={filePath}
        originalMarkdown={value}
        proposedMarkdown={proposedMarkdown ?? ''}
        model={model || DEFAULT_OPENROUTER_MODEL}
        onAccept={handleAcceptProposed}
        onReject={handleRejectProposed}
      />
    </div>
  );
}
