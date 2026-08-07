import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { OpenRouterSettings } from '../openrouter/storage';
import { OpenRouterSettingsPanel } from './OpenRouterSettingsPanel';
import { RocketReachSettingsPanel } from './RocketReachSettingsPanel';

/** The sections of the single settings home. */
export type SettingsSection = 'integrations' | 'openrouter';

interface SettingsDialogProps {
  open: boolean;
  /** Section to land on when the dialog opens. Defaults to `integrations`. */
  initialSection?: SettingsSection;
  onClose: () => void;
  /** Notified when the OpenRouter panel persists new credentials. */
  onOpenRouterSaved?: (next: OpenRouterSettings) => void;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string; hint: string }> = [
  { id: 'integrations', label: 'Integrations', hint: 'RocketReach prospect research' },
  { id: 'openrouter', label: 'AI formatting', hint: 'OpenRouter key and model' },
];

/**
 * The single home for app configuration.
 *
 * App settings used to live in two unrelated dialogs — RocketReach hanging off
 * an unlabeled topbar glyph, OpenRouter off a gear in the editor toolbar — so
 * there was no one place a user could look. Both now render as sections here,
 * and both entry points open this same dialog (the editor's gear simply lands
 * on the OpenRouter section).
 */
export function SettingsDialog({
  open,
  initialSection = 'integrations',
  onClose,
  onOpenRouterSaved,
}: SettingsDialogProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Each opening starts from the section the caller asked for, so the editor's
  // gear always lands on OpenRouter even after a previous visit to Integrations.
  useEffect(() => {
    if (open) {
      setSection(initialSection);
    }
  }, [open, initialSection]);

  useEffect(() => {
    if (!open) {
      return;
    }

    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    focusables?.[0]?.focus();

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) {
        return;
      }
      const nodes = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (!nodes.length) {
        event.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (active === first || active === dialogRef.current) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocusedRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  function moveSection(delta: number) {
    const index = SECTIONS.findIndex((entry) => entry.id === section);
    const next = SECTIONS[(index + delta + SECTIONS.length) % SECTIONS.length];
    setSection(next.id);
    document.getElementById(`settings-tab-${next.id}`)?.focus();
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      moveSection(1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSection(-1);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-dialog modal-info settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="settings-dialog-title">Settings</h2>

        <div className="settings-tabs" role="tablist" aria-label="Settings sections">
          {SECTIONS.map((entry) => {
            const selected = entry.id === section;
            return (
              <button
                key={entry.id}
                id={`settings-tab-${entry.id}`}
                type="button"
                role="tab"
                className={selected ? 'settings-tab is-selected' : 'settings-tab'}
                aria-selected={selected}
                aria-controls={`settings-panel-${entry.id}`}
                title={entry.hint}
                onClick={() => setSection(entry.id)}
                onKeyDown={handleTabKeyDown}
              >
                {entry.label}
              </button>
            );
          })}
        </div>

        <div
          className="settings-dialog__body"
          id={`settings-panel-${section}`}
          role="tabpanel"
          aria-labelledby={`settings-tab-${section}`}
        >
          {section === 'integrations' ? (
            <RocketReachSettingsPanel />
          ) : (
            <OpenRouterSettingsPanel onSaved={onOpenRouterSaved} />
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="primary-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
