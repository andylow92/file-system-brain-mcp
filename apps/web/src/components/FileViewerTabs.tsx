import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { DocumentFormat } from '@repo/shared';

export type ViewerTabKey =
  'preview' | 'source' | 'edit' | 'split' | 'activity' | 'review' | 'graph';

interface FileViewerTabsProps {
  activeTab: ViewerTabKey;
  onTabChange: (tab: ViewerTabKey) => void;
  /** Format of the open document. HTML is read-only: Source instead of Split/Edit. */
  documentFormat?: DocumentFormat;
  preview: ReactNode;
  /** Raw-source view, offered for HTML documents only. */
  source?: ReactNode;
  edit: ReactNode;
  activity: ReactNode;
  review: ReactNode;
  graph: ReactNode;
  /** Number of pending proposals, shown as a badge on the Review tab. */
  reviewCount?: number;
}

/** Display order. Each tab's accent comes from its `data-tab` (see styles.css). */
const TABS: ReadonlyArray<{ key: ViewerTabKey; label: string }> = [
  { key: 'preview', label: 'Preview' },
  { key: 'source', label: 'Source' },
  { key: 'split', label: 'Split' },
  { key: 'edit', label: 'Edit' },
  { key: 'activity', label: 'Activity' },
  { key: 'review', label: 'Review' },
  { key: 'graph', label: 'Graph' },
];

const READ_ONLY_REASON = 'HTML documents are read-only. Only Markdown notes can be edited.';

/**
 * The tab actually shown: a read-only HTML document has no Edit/Split, and a
 * Markdown note has no Source, so either falls back to Preview. Selection state
 * always follows what is shown.
 */
function shownTab(activeTab: ViewerTabKey, isHtml: boolean): ViewerTabKey {
  if (isHtml && (activeTab === 'edit' || activeTab === 'split')) {
    return 'preview';
  }
  if (!isHtml && activeTab === 'source') {
    return 'preview';
  }
  return activeTab;
}

export function FileViewerTabs({
  activeTab,
  onTabChange,
  documentFormat = 'markdown',
  preview,
  source,
  edit,
  activity,
  review,
  graph,
  reviewCount = 0,
}: FileViewerTabsProps) {
  const baseId = useId();
  const tabRefs = useRef(new Map<ViewerTabKey, HTMLButtonElement>());
  const isHtml = documentFormat === 'html';
  const shown = shownTab(activeTab, isHtml);
  const tabs = TABS.filter((tab) => tab.key !== 'source' || isHtml);
  const readOnlyId = `${baseId}-read-only`;
  const tabId = (key: ViewerTabKey) => `${baseId}-tab-${key}`;
  const panelId = (key: ViewerTabKey) => `${baseId}-panel-${key}`;
  const isDisabled = (key: ViewerTabKey) => isHtml && (key === 'edit' || key === 'split');

  function activate(key: ViewerTabKey) {
    if (!isDisabled(key)) {
      onTabChange(key);
    }
  }

  // WAI-ARIA tabs with *manual* activation: arrows / Home / End only move focus
  // (so arrowing past Graph doesn't load it); Enter / Space activate.
  // Read-only tabs stay focusable so their explanation can be discovered.
  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = (index + 1) % tabs.length;
        break;
      case 'ArrowLeft':
        next = (index - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = tabs.length - 1;
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        activate(tabs[index].key);
        return;
      default:
        return;
    }
    event.preventDefault();
    tabRefs.current.get(tabs[next].key)?.focus();
  }

  return (
    <section className="viewer-region">
      <div className="tabs" role="tablist" aria-label="File tabs">
        {tabs.map((tab, index) => {
          const selected = tab.key === shown;
          const disabled = isDisabled(tab.key);
          return (
            <button
              key={tab.key}
              ref={(node) => {
                if (node) {
                  tabRefs.current.set(tab.key, node);
                } else {
                  tabRefs.current.delete(tab.key);
                }
              }}
              type="button"
              role="tab"
              id={tabId(tab.key)}
              data-tab={tab.key}
              aria-selected={selected}
              aria-controls={panelId(tab.key)}
              aria-disabled={disabled || undefined}
              aria-describedby={disabled ? readOnlyId : undefined}
              title={disabled ? READ_ONLY_REASON : undefined}
              tabIndex={selected ? 0 : -1}
              className={selected ? 'tab active' : 'tab'}
              onClick={() => activate(tab.key)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              <span className="tab-label" data-label={tab.label}>
                {tab.label}
              </span>
              {tab.key === 'review' && reviewCount > 0 ? (
                <span className="tab-badge">{reviewCount}</span>
              ) : null}
            </button>
          );
        })}
        {isHtml ? (
          // Visible, non-color cue; screen readers get the full reason through
          // the disabled tabs' description and the preview caption instead.
          <span className="tab-readonly-chip" aria-hidden="true" title={READ_ONLY_REASON}>
            Read-only
          </span>
        ) : null}
      </div>
      {isHtml ? (
        <span id={readOnlyId} hidden>
          {READ_ONLY_REASON}
        </span>
      ) : null}
      <div
        className="tab-content"
        id={panelId(shown)}
        role="tabpanel"
        aria-labelledby={tabId(shown)}
      >
        {shown === 'split' ? (
          <div className="split-view">
            <div className="split-pane split-edit">{edit}</div>
            <div className="split-pane split-preview">{preview}</div>
          </div>
        ) : shown === 'preview' ? (
          preview
        ) : shown === 'source' ? (
          source
        ) : shown === 'activity' ? (
          activity
        ) : shown === 'review' ? (
          review
        ) : shown === 'graph' ? (
          graph
        ) : (
          edit
        )}
      </div>
    </section>
  );
}
