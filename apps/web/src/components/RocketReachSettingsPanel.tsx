import { useEffect, useState } from 'react';

import type { RocketReachStatus } from '@repo/shared';

import { getRocketReachStatus, testRocketReach, updateRocketReach } from '../api/integrations';

function stateLabel(status: RocketReachStatus | null): string {
  if (!status) return 'Loading…';
  switch (status.state) {
    case 'disabled':
      return 'Disabled';
    case 'enabled_unconfigured':
      return 'Enabled — no API key yet';
    case 'enabled':
      return 'Enabled and configured';
    default:
      return 'Unknown';
  }
}

/**
 * Settings panel for the optional RocketReach prospect-research integration.
 * The raw API key never leaves the server, so this panel only ever shows a
 * masked hint; the input is write-only (type a new key to replace it).
 *
 * Rendered inside {@link SettingsDialog} — it owns no modal chrome of its own.
 */
export function RocketReachSettingsPanel() {
  const [status, setStatus] = useState<RocketReachStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getRocketReachStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMessage({
            kind: 'error',
            text: error instanceof Error ? error.message : 'Failed to load',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const enabled = status?.enabled ?? false;

  async function runUpdate(patch: { enabled?: boolean; apiKey?: string | null }, okText: string) {
    setBusy(true);
    setMessage(null);
    try {
      const next = await updateRocketReach(patch);
      setStatus(next);
      setApiKey('');
      setMessage({ kind: 'ok', text: okText });
    } catch (error: unknown) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Update failed' });
    } finally {
      setBusy(false);
    }
  }

  function handleToggleEnabled(nextEnabled: boolean) {
    void runUpdate(
      { enabled: nextEnabled },
      nextEnabled ? 'RocketReach enabled.' : 'RocketReach disabled.',
    );
  }

  function handleSaveKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setMessage({ kind: 'error', text: 'Enter an API key to save.' });
      return;
    }
    void runUpdate({ enabled: true, apiKey: trimmed }, 'API key saved.');
  }

  function handleRemoveKey() {
    void runUpdate({ apiKey: null }, 'API key removed.');
  }

  async function handleTest() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await testRocketReach();
      const credits = result.account.lookupCreditBalance;
      // An uncapped tier reports `'unlimited'`, not a count — say so rather than
      // rendering it as a quantity or falling through to "no figure at all".
      const creditsLabel =
        credits === 'unlimited'
          ? ' · unlimited lookup credits'
          : credits != null
            ? ` · ${credits} lookup credits remaining`
            : '';
      setMessage({ kind: 'ok', text: `Connected${creditsLabel}.` });
    } catch (error: unknown) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Connection test failed',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-panel">
      <h3 className="settings-panel__title">RocketReach</h3>
      <p className="settings-panel__intro">
        Optional prospect-research integration. Off by default. When enabled, connected agents get
        RocketReach tools for guided intake, people search, and (paid) contact lookups. Your API key
        is stored on your machine (never in notes) and is never shown again once saved.
      </p>

      <p className="settings-hint">
        Status: <strong>{stateLabel(status)}</strong>
        {status?.keyHint ? (
          <>
            {' '}
            · key <code>{status.keyHint}</code>
          </>
        ) : null}
      </p>

      <label className="settings-field settings-toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy || !status}
          onChange={(event) => handleToggleEnabled(event.target.checked)}
        />
        <span className="settings-label">Enable RocketReach</span>
      </label>

      {/* The MCP server decides which tools to register once, at startup. Turning
          the integration on here is therefore only half the story, and without
          this note the "I enabled it but no tools appeared" gap reads as a bug. */}
      <p className="settings-callout">
        <strong>Enabling is not enough on its own.</strong> The MCP server registers RocketReach
        tools at startup, so restart it (<code>npm run start:agent</code>) and reconnect your agent
        before <code>rocketreach_*</code> tools show up. Turning the integration <em>off</em> takes
        effect immediately — every call fails closed, restart or not.
      </p>

      <form className="settings-form" onSubmit={handleSaveKey}>
        <label className="settings-field">
          <span className="settings-label">API key</span>
          <div className="settings-key-row">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                status?.configured ? 'Stored — type to replace' : 'Paste your RocketReach API key'
              }
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
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
            <a href="https://rocketreach.co/api" target="_blank" rel="noreferrer noopener">
              rocketreach.co/api
            </a>
            .
          </p>
        </label>

        {message ? (
          <p
            className={
              message.kind === 'ok' ? 'settings-hint settings-ok' : 'settings-hint settings-error'
            }
          >
            {message.text}
          </p>
        ) : null}

        <div className="modal-actions">
          <button
            type="button"
            className="primary-btn"
            onClick={() => void handleTest()}
            disabled={busy || !status?.configured}
            title={status?.configured ? 'Test the stored key' : 'Save a key first'}
          >
            Test connection
          </button>
          {status?.configured ? (
            <button type="button" className="danger-btn" onClick={handleRemoveKey} disabled={busy}>
              Remove key
            </button>
          ) : null}
          <button type="submit" className="save-button" disabled={busy}>
            Save key
          </button>
        </div>
      </form>
    </div>
  );
}
