import { useState } from 'react';
import type { MaintenanceFinding } from '@repo/shared';
import { getErrorMessage, runMaintenance } from '../api/files';

const KIND_LABEL: Record<MaintenanceFinding['kind'], string> = {
  broken_link: 'Broken links',
  duplicate: 'Possible duplicates',
  schema: 'Schema issues',
  stale: 'Stale but load-bearing',
  orphan: 'Orphan notes',
};

const KIND_ORDER: MaintenanceFinding['kind'][] = [
  'broken_link',
  'duplicate',
  'schema',
  'stale',
  'orphan',
];

interface MaintenancePanelProps {
  /** Called after a scan files proposals, so the Review list below can refresh. */
  onFiled?: () => void;
}

/**
 * The human-facing entry point for the dream cycle. A single action runs the
 * vault maintenance scan; findings are listed grouped by kind, and any
 * actionable ones are filed as proposals that show up in the Review queue just
 * below — where the human approves or rejects them (resolution stays human-only).
 */
export function MaintenancePanel({ onFiled }: MaintenancePanelProps) {
  const [findings, setFindings] = useState<MaintenanceFinding[] | null>(null);
  const [filedCount, setFiledCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleScan() {
    setLoading(true);
    setError(null);
    try {
      const result = await runMaintenance();
      setFindings(result.findings);
      setFiledCount(result.proposalsFiled.length);
      if (result.proposalsFiled.length > 0) {
        onFiled?.();
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  const groups = KIND_ORDER.map((kind) => ({
    kind,
    items: (findings ?? []).filter((finding) => finding.kind === kind),
  })).filter((group) => group.items.length > 0);

  return (
    <section className="maintenance-panel" aria-label="Vault maintenance">
      <div className="maintenance-panel__head">
        <div>
          <h3 className="maintenance-panel__title">Dream-cycle maintenance</h3>
          <p className="maintenance-panel__hint">
            Scan for broken links, orphan notes, near-duplicates, and stale but load-bearing notes —
            actionable fixes are filed as proposals below for you to approve or reject. Schema
            issues are listed for you to correct in the note&rsquo;s frontmatter (never filed as
            proposals).
          </p>
        </div>
        <button
          type="button"
          className="primary-btn"
          disabled={loading}
          onClick={() => void handleScan()}
        >
          {loading ? 'Scanning…' : 'Run scan'}
        </button>
      </div>

      {error ? <p className="review-item__error">{error}</p> : null}

      {findings !== null ? (
        findings.length === 0 ? (
          <p className="empty-state">No maintenance issues found — the vault is healthy.</p>
        ) : (
          <>
            <p className="maintenance-panel__summary">
              {findings.length} finding{findings.length === 1 ? '' : 's'}
              {filedCount > 0
                ? ` · ${filedCount} new proposal${filedCount === 1 ? '' : 's'} filed`
                : ' · no new proposals filed'}
            </p>
            <ul className="maintenance-groups">
              {groups.map((group) => (
                <li key={group.kind} className="maintenance-group">
                  <span className="maintenance-group__kind">
                    {KIND_LABEL[group.kind]} ({group.items.length})
                  </span>
                  <ul className="maintenance-group__items">
                    {group.items.map((finding, index) => (
                      <li key={`${group.kind}-${index}`} className="maintenance-finding">
                        {finding.detail}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}
    </section>
  );
}
