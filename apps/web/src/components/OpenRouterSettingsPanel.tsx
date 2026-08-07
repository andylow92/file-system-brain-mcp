import { useState } from 'react';

import {
  DEFAULT_OPENROUTER_MODEL,
  SUGGESTED_OPENROUTER_MODELS,
  loadOpenRouterSettings,
  saveOpenRouterSettings,
  type OpenRouterSettings,
} from '../openrouter/storage';

interface OpenRouterSettingsPanelProps {
  /** Called after the new settings have been persisted. */
  onSaved?: (next: OpenRouterSettings) => void;
}

/**
 * Settings panel for the OpenRouter key/model used by the editor's "Fix format"
 * action. The key lives in this browser only and is sent straight to OpenRouter.
 *
 * Rendered inside {@link SettingsDialog} — it owns no modal chrome of its own.
 */
export function OpenRouterSettingsPanel({ onSaved }: OpenRouterSettingsPanelProps) {
  const [initial] = useState(() => loadOpenRouterSettings());
  const [apiKey, setApiKey] = useState(initial.apiKey);
  const [model, setModel] = useState(initial.model || DEFAULT_OPENROUTER_MODEL);
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = saveOpenRouterSettings({ apiKey, model });
    setApiKey(next.apiKey);
    setModel(next.model);
    setSaved(true);
    onSaved?.(next);
  }

  return (
    <div className="settings-panel">
      <h3 className="settings-panel__title">OpenRouter</h3>
      <p className="settings-panel__intro">
        Used by the “Fix format” button in the editor. Your key is stored in this browser only and
        sent directly to OpenRouter.
      </p>

      <form className="settings-form" onSubmit={handleSubmit}>
        <label className="settings-field">
          <span className="settings-label">API key</span>
          <div className="settings-key-row">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
                setSaved(false);
              }}
              placeholder="sk-or-..."
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="primary-btn settings-key-toggle"
              onClick={() => setShowKey((current) => !current)}
              aria-label={showKey ? 'Hide API key' : 'Show API key'}
            >
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>
          <p className="settings-hint">
            Get a key at{' '}
            <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer noopener">
              openrouter.ai/keys
            </a>
            .
          </p>
        </label>

        <label className="settings-field">
          <span className="settings-label">Model</span>
          <input
            list="openrouter-model-suggestions"
            value={model}
            onChange={(event) => {
              setModel(event.target.value);
              setSaved(false);
            }}
            placeholder={DEFAULT_OPENROUTER_MODEL}
            spellCheck={false}
            autoComplete="off"
          />
          <datalist id="openrouter-model-suggestions">
            {SUGGESTED_OPENROUTER_MODELS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </datalist>
          <p className="settings-hint">
            Default: <code>{DEFAULT_OPENROUTER_MODEL}</code>. Any OpenRouter model id works.
          </p>
        </label>

        {saved ? <p className="settings-hint settings-ok">OpenRouter settings saved.</p> : null}

        <div className="modal-actions">
          <button type="submit" className="save-button">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
