import { useEffect, useRef, useState } from 'react';

import type {
  AuthAccess,
  AuthAgentRule,
  AuthDefaultAccess,
  AuthStatusResponse,
} from '@repo/shared';

import { getAuthStatus, testAuthToken, updateAuthSettings } from '../api/auth';

interface AuthSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type JwksKind = 'none' | 'inline' | 'file' | 'url';

function stateLabel(status: AuthStatusResponse | null): string {
  if (!status) return 'Loading…';
  if (!status.enabled) return 'Disabled — vault trusts its network (local-first default)';
  return status.bearerReady
    ? 'Enabled — remote agents must present a SPIFFE identity'
    : 'Enabled — mTLS certificates only (no JWKS configured for bearer tokens)';
}

/**
 * Settings dialog for the optional SPIFFE auth layer ("Vault access").
 * Off by default; everything here is a thin client over `/api/auth`, which is
 * the single source of truth. Auth settings can only be changed from the
 * machine running the vault (or by an agent granted `admin`), so this dialog
 * is primarily the owner's loopback surface.
 */
export function AuthSettingsDialog({ open, onClose }: AuthSettingsDialogProps) {
  const [status, setStatus] = useState<AuthStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const [trustDomain, setTrustDomain] = useState('');
  const [audience, setAudience] = useState('fsbrain');
  const [allowLoopback, setAllowLoopback] = useState(true);
  const [defaultAccess, setDefaultAccess] = useState<AuthDefaultAccess>('readwrite');
  const [jwksKind, setJwksKind] = useState<JwksKind>('none');
  const [jwksValue, setJwksValue] = useState('');
  const [rules, setRules] = useState<AuthAgentRule[]>([]);
  const [newRuleId, setNewRuleId] = useState('');
  const [newRuleMatch, setNewRuleMatch] = useState<'exact' | 'prefix'>('exact');
  const [newRuleAccess, setNewRuleAccess] = useState<AuthAccess>('readwrite');
  const [testToken, setTestToken] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  function applyStatus(next: AuthStatusResponse) {
    setStatus(next);
    setTrustDomain(next.trustDomain ?? '');
    setAudience(next.audience);
    setAllowLoopback(next.allowLoopback);
    setDefaultAccess(next.defaultAccess);
    setJwksKind(next.jwksSource ?? 'none');
    setJwksValue('');
    setRules(next.agents ?? []);
  }

  useEffect(() => {
    if (!open) {
      return;
    }
    setMessage(null);
    setTestToken('');
    setTestResult(null);
    setStatus(null);
    let cancelled = false;
    void getAuthStatus()
      .then((next) => {
        if (!cancelled) applyStatus(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMessage({
            kind: 'error',
            text: error instanceof Error ? error.message : 'Failed to load auth settings',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    focusables?.[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
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

  const enabled = status?.enabled ?? false;

  async function runUpdate(
    patch: Parameters<typeof updateAuthSettings>[0],
    okText: string,
  ): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const next = await updateAuthSettings(patch);
      applyStatus(next);
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
      nextEnabled
        ? 'Auth enabled — remote requests now need a SPIFFE identity.'
        : 'Auth disabled — the vault is open again.',
    );
  }

  function handleSaveConfiguration(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const patch: Parameters<typeof updateAuthSettings>[0] = {
      trustDomain: trustDomain.trim() || null,
      audience: audience.trim() || 'fsbrain',
      allowLoopback,
      defaultAccess,
      agents: rules,
    };
    const typed = jwksValue.trim();
    if (jwksKind === 'none') {
      // Only clear a stored source when the user explicitly selected "none".
      if (status?.jwksSource) patch.jwks = null;
    } else if (typed) {
      patch.jwks = { [jwksKind]: typed };
    }
    void runUpdate(patch, 'Auth settings saved.');
  }

  function handleAddRule() {
    const id = newRuleId.trim();
    if (!id.startsWith('spiffe://')) {
      setMessage({ kind: 'error', text: 'Rule id must be a spiffe:// identity or prefix.' });
      return;
    }
    setRules((current) => [...current, { id, match: newRuleMatch, access: newRuleAccess }]);
    setNewRuleId('');
    setMessage(null);
  }

  function handleRemoveRule(index: number) {
    setRules((current) => current.filter((_, i) => i !== index));
  }

  async function handleTestToken() {
    const token = testToken.trim();
    if (!token) {
      setTestResult('Paste a JWT-SVID to test.');
      return;
    }
    setBusy(true);
    setTestResult(null);
    try {
      const result = await testAuthToken(token);
      setTestResult(
        result.valid
          ? `Valid — ${result.spiffeId} (access: ${result.access ?? 'none'})`
          : `Rejected — ${result.reason ?? 'unknown reason'}`,
      );
    } catch (error: unknown) {
      setTestResult(error instanceof Error ? error.message : 'Test failed');
    } finally {
      setBusy(false);
    }
  }

  const jwksPlaceholder =
    jwksKind === 'inline'
      ? status?.jwksSource === 'inline'
        ? 'Configured — paste to replace'
        : '{"keys":[ … ]}'
      : jwksKind === 'file'
        ? status?.jwksSource === 'file'
          ? 'Configured — type a new absolute path to replace'
          : '/etc/spire/bundle.jwks.json (path on the vault server)'
        : status?.jwksSource === 'url'
          ? 'Configured — type a new URL to replace'
          : 'https://spire.example.org/keys';

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-dialog modal-info auth-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-settings-title"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="auth-settings-title">Vault access (SPIFFE auth)</h2>
        <p>
          Optional identity check for sharing this vault with agents on other machines. Off by
          default — nothing changes until you enable it. When enabled, remote requests must present
          a <a href="https://spiffe.io">SPIFFE</a> identity (a JWT-SVID bearer token or an mTLS
          certificate) in your trust domain, and every write is attributed to that verified identity
          in the audit log.
        </p>

        <p className="settings-hint">
          Status: <strong>{stateLabel(status)}</strong>
          {status?.caller.kind === 'spiffe' ? (
            <>
              {' '}
              · you are <code>{status.caller.spiffeId}</code>
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
          <span className="settings-label">Require SPIFFE identity for remote requests</span>
        </label>
        <p className="settings-hint">
          Loopback (this machine) stays exempt while “allow loopback” is on, so this UI and a local
          embedded agent keep working. Settings on this page can only be changed from the vault’s
          own machine or by an agent granted <code>admin</code>.
        </p>

        <form className="settings-form" onSubmit={handleSaveConfiguration}>
          <label className="settings-field">
            <span className="settings-label">Trust domain</span>
            <input
              type="text"
              value={trustDomain}
              onChange={(event) => setTrustDomain(event.target.value)}
              placeholder="example.org"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
          </label>

          <label className="settings-field">
            <span className="settings-label">Audience (JWT aud claim)</span>
            <input
              type="text"
              value={audience}
              onChange={(event) => setAudience(event.target.value)}
              placeholder="fsbrain"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
          </label>

          <label className="settings-field">
            <span className="settings-label">JWKS source (verifies JWT-SVID bearer tokens)</span>
            <select
              value={jwksKind}
              onChange={(event) => setJwksKind(event.target.value as JwksKind)}
              disabled={busy}
            >
              <option value="none">None (mTLS certificates only)</option>
              <option value="inline">Inline JWKS JSON</option>
              <option value="file">File on the vault server</option>
              <option value="url">URL (e.g. SPIRE OIDC discovery)</option>
            </select>
          </label>
          {jwksKind === 'inline' ? (
            <label className="settings-field">
              <span className="settings-label">JWKS JSON</span>
              <textarea
                value={jwksValue}
                onChange={(event) => setJwksValue(event.target.value)}
                placeholder={jwksPlaceholder}
                rows={3}
                spellCheck={false}
                disabled={busy}
              />
            </label>
          ) : jwksKind !== 'none' ? (
            <label className="settings-field">
              <span className="settings-label">
                {jwksKind === 'file' ? 'JWKS file path' : 'JWKS URL'}
              </span>
              <input
                type="text"
                value={jwksValue}
                onChange={(event) => setJwksValue(event.target.value)}
                placeholder={jwksPlaceholder}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
            </label>
          ) : null}

          <label className="settings-field">
            <span className="settings-label">Default access for verified identities</span>
            <select
              value={defaultAccess}
              onChange={(event) => setDefaultAccess(event.target.value as AuthDefaultAccess)}
              disabled={busy}
            >
              <option value="readwrite">Read & write (any identity in the trust domain)</option>
              <option value="read">Read-only</option>
              <option value="none">None (allow-listed agents only)</option>
            </select>
          </label>

          <label className="settings-field settings-toggle">
            <input
              type="checkbox"
              checked={allowLoopback}
              onChange={(event) => setAllowLoopback(event.target.checked)}
              disabled={busy}
            />
            <span className="settings-label">Allow loopback without identity (recommended)</span>
          </label>
          {!allowLoopback ? (
            <p className="settings-hint">
              ⚠ With loopback exemption off, even this UI must authenticate. Keep an{' '}
              <code>admin</code> rule below (or disk access to <code>.fsbrain/auth.json</code>) so
              you cannot lock yourself out. Use this when a reverse proxy on the same host makes
              remote traffic look local.
            </p>
          ) : null}

          <div className="settings-field">
            <span className="settings-label">
              Agent access rules (first match wins by specificity)
            </span>
            {rules.length === 0 ? (
              <p className="settings-hint">
                No rules — the default access above applies to everyone.
              </p>
            ) : (
              <ul className="auth-rule-list">
                {rules.map((rule, index) => (
                  <li key={`${rule.id}-${index}`} className="auth-rule-row">
                    <code className="auth-rule-id">{rule.id}</code>
                    <span className="auth-rule-meta">
                      {rule.match} · {rule.access}
                    </span>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => handleRemoveRule(index)}
                      aria-label={`Remove rule for ${rule.id}`}
                      disabled={busy}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="auth-rule-add">
              <input
                type="text"
                value={newRuleId}
                onChange={(event) => setNewRuleId(event.target.value)}
                placeholder="spiffe://example.org/agent/name"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                aria-label="New rule SPIFFE id"
              />
              <select
                value={newRuleMatch}
                onChange={(event) => setNewRuleMatch(event.target.value as 'exact' | 'prefix')}
                disabled={busy}
                aria-label="New rule match kind"
              >
                <option value="exact">exact</option>
                <option value="prefix">prefix</option>
              </select>
              <select
                value={newRuleAccess}
                onChange={(event) => setNewRuleAccess(event.target.value as AuthAccess)}
                disabled={busy}
                aria-label="New rule access"
              >
                <option value="read">read</option>
                <option value="readwrite">readwrite</option>
                <option value="admin">admin</option>
              </select>
              <button type="button" className="primary-btn" onClick={handleAddRule} disabled={busy}>
                Add
              </button>
            </div>
          </div>

          <div className="settings-key-row">
            <button type="submit" className="primary-btn" disabled={busy || !status}>
              Save settings
            </button>
          </div>
        </form>

        <div className="settings-form">
          <label className="settings-field">
            <span className="settings-label">Test a token (dry run — nothing is granted)</span>
            <textarea
              value={testToken}
              onChange={(event) => setTestToken(event.target.value)}
              placeholder="Paste a JWT-SVID to check who it is and what it would get"
              rows={2}
              spellCheck={false}
              disabled={busy}
            />
          </label>
          <div className="settings-key-row">
            <button
              type="button"
              className="primary-btn"
              onClick={() => void handleTestToken()}
              disabled={busy || !status}
            >
              Test token
            </button>
          </div>
          {testResult ? <p className="settings-hint">{testResult}</p> : null}
        </div>

        {message ? (
          <p className={message.kind === 'ok' ? 'settings-hint' : 'settings-hint settings-error'}>
            {message.text}
          </p>
        ) : null}

        <div className="modal-actions">
          <button type="button" className="primary-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
