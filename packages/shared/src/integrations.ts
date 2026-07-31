/**
 * Optional third-party integrations for fsbrain.
 *
 * The first (and, for now, only) integration is **RocketReach** — a
 * prospect-research provider. Integrations are *opt-in*: disabled by default,
 * enabled per-user from settings, and their agent-facing MCP tools only appear
 * once the integration is turned on. This module holds the provider-agnostic
 * types plus the RocketReach-specific contracts shared across the API, the MCP
 * server, and the web UI.
 *
 * Nothing here performs I/O or holds a secret — it is pure data and helpers so
 * it can be unit-tested and imported from any workspace.
 */

/** Stable identifiers for the integrations fsbrain knows about. */
export type IntegrationId = 'rocketreach';

/**
 * The three states an integration surface can be in, used to drive the settings
 * UI copy and to decide whether API calls are permitted.
 * - `disabled` — off; no tools exposed, no calls allowed.
 * - `enabled_unconfigured` — on, but no API key yet; tools return "setup required".
 * - `enabled` — on and configured; calls are permitted.
 */
export type IntegrationState = 'disabled' | 'enabled_unconfigured' | 'enabled';

/**
 * Redacted status of the RocketReach integration. **Never** carries the API key
 * — only a masked hint suitable for display. This is the shape returned by the
 * status/config endpoints and consumed by the settings dialog.
 */
export interface RocketReachStatus {
  enabled: boolean;
  /** True when a non-empty API key is stored. */
  configured: boolean;
  state: IntegrationState;
  /** e.g. `abcd…wxyz` — enough to recognize the key, never enough to use it. */
  keyHint?: string;
}

/** The kinds of answer an intake question expects, so a UI/agent can render it. */
export type IntakeFieldKind = 'text' | 'longtext' | 'list' | 'number' | 'boolean' | 'choice';

/** A single guided-intake question the agent asks before spending credits. */
export interface IntakeQuestion {
  /** Stable key the answer is filed under. */
  id: string;
  /** Human/agent-facing question text. */
  prompt: string;
  kind: IntakeFieldKind;
  /** Whether an answer is required before a search can run. */
  required: boolean;
  /** Optional clarifying help text. */
  help?: string;
  /** Allowed values for `choice`-kind questions. */
  options?: string[];
}

/**
 * The standardized prospect-research intake. An agent calls
 * `rocketreach_start_intake`, asks the user these questions, then maps the
 * answers onto {@link RocketReachSearchCriteria}. Deliberately static and
 * provider-shaped so every run is comparable and auditable.
 */
export const ROCKETREACH_INTAKE_QUESTIONS: readonly IntakeQuestion[] = [
  {
    id: 'audience',
    prompt: 'Who are you trying to contact? Describe the ideal person in a sentence.',
    kind: 'text',
    required: true,
  },
  {
    id: 'titles',
    prompt: 'Which job titles or roles matter most?',
    kind: 'list',
    required: false,
    help: 'e.g. "VP Engineering", "Head of Data", "Founder".',
  },
  {
    id: 'regions',
    prompt: 'Which countries or regions should I search?',
    kind: 'list',
    required: false,
    help: 'Leave empty to search everywhere.',
  },
  {
    id: 'companies',
    prompt: 'Are there specific target companies?',
    kind: 'list',
    required: false,
  },
  {
    id: 'industries',
    prompt: 'Any target industries?',
    kind: 'list',
    required: false,
  },
  {
    id: 'keywords',
    prompt: 'Any extra keywords to narrow the search?',
    kind: 'list',
    required: false,
  },
  {
    id: 'maxCandidates',
    prompt: 'How many candidates should I return at most (search only, no credits spent)?',
    kind: 'number',
    required: false,
    help: `Defaults to ${/* keep in sync with DEFAULT_MAX_CANDIDATES */ 25}.`,
  },
  {
    id: 'maxLookups',
    prompt: 'How many paid RocketReach lookup credits may I spend at most?',
    kind: 'number',
    required: true,
    help: 'A hard cap. Enrichment (emails/phones) will never exceed it. 0 means search-only.',
  },
  {
    id: 'requireWorkEmail',
    prompt: 'Should I require a work email?',
    kind: 'boolean',
    required: false,
  },
  {
    id: 'save',
    prompt: 'Save results into fsbrain, export files, or both?',
    kind: 'choice',
    required: false,
    options: ['fsbrain', 'none'],
  },
  {
    id: 'project',
    prompt: 'What project, company, or sender identity should this research be associated with?',
    kind: 'text',
    required: false,
  },
];

/** Default ceiling on returned candidates for a search-only pass. */
export const DEFAULT_MAX_CANDIDATES = 25;
/** Absolute ceiling on candidates regardless of what a caller asks for. */
export const MAX_CANDIDATES_LIMIT = 100;

/** Normalized, provider-shaped search criteria (the output of the intake). */
export interface RocketReachSearchCriteria {
  /** Free-text description of the audience (maps to a keyword query). */
  audience?: string;
  titles?: string[];
  regions?: string[];
  companies?: string[];
  industries?: string[];
  keywords?: string[];
  /** Cap on returned candidates; clamped to {@link MAX_CANDIDATES_LIMIT}. */
  maxCandidates?: number;
  requireWorkEmail?: boolean;
  /** Skip candidates already present in the vault when true. */
  dedupe?: boolean;
  /** Where to persist the run: a vault note, or nowhere. */
  save?: 'fsbrain' | 'none';
  /** Association label (project / company / sender identity) for provenance. */
  project?: string;
}

/** A candidate returned by a (free) search — identity only, no paid contact data. */
export interface RocketReachCandidate {
  /** RocketReach profile id, used to request enrichment. */
  id: string;
  name: string;
  title?: string;
  company?: string;
  location?: string;
  linkedinUrl?: string;
  profileUrl?: string;
  /** Whether RocketReach believes a work email is available (pre-lookup hint). */
  hasWorkEmail?: boolean;
}

/** An enriched contact after a (paid) lookup. */
export interface RocketReachContact extends RocketReachCandidate {
  emails?: string[];
  phones?: string[];
  /** RocketReach enrichment status, e.g. `complete` / `searching`. */
  status?: string;
}

/** Account/credit snapshot from RocketReach, used for the connection test + budgeting. */
export interface RocketReachAccountStatus {
  plan?: string;
  /** Remaining paid lookup credits. */
  lookupCreditBalance?: number;
  /** Name/email on the account, when the provider returns it. */
  accountName?: string;
}

/** A durable, auditable record of one prospect-research run, saved into the vault. */
export interface RocketReachRunRecord {
  /** ISO timestamp the run finished. */
  generatedAt: string;
  actor: string;
  /** The raw intake answers, as given by the user. */
  intake?: Record<string, unknown>;
  criteria: RocketReachSearchCriteria;
  creditsBefore?: number;
  creditsAfter?: number;
  candidates: RocketReachCandidate[];
  /** Candidates that were enriched (paid). */
  enriched: RocketReachContact[];
  /** Candidates skipped (e.g. dedupe, missing work email). */
  skipped?: { id: string; reason: string }[];
  /** Association label carried from the criteria for grouping. */
  project?: string;
}

/**
 * Mask an API key for display: keep a few leading/trailing characters, hide the
 * middle. Returns `undefined` for empty input. Never returns the raw key.
 */
export function maskApiKey(key: string | undefined | null): string | undefined {
  if (!key) {
    return undefined;
  }
  const trimmed = key.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= 8) {
    return '•'.repeat(trimmed.length);
  }
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

/**
 * Redact every occurrence of the given secrets from a string, so an API key can
 * never leak through an error message, log line, or tool response. Empty/short
 * secrets are ignored (redacting them would blank out unrelated text). Callers
 * should pass this over anything derived from a provider error before surfacing it.
 */
export function redactSecrets(text: string, secrets: Array<string | undefined | null>): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 6) {
      continue;
    }
    // Escape regex metacharacters in the secret before building the matcher.
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), '«redacted»');
  }
  return out;
}

/** Turn an arbitrary label into a filesystem/link-safe slug. */
export function slugifyRun(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'run';
}

/**
 * Build the markdown note (path + content) that records a research run in the
 * vault. Pure and deterministic — the caller supplies the timestamp — so the
 * exact note is easy to assert in tests. The note lives under `prospects/` with
 * frontmatter provenance (actor, timestamp, normalized params, credit deltas).
 */
export function buildRunRecordNote(record: RocketReachRunRecord): {
  path: string;
  content: string;
} {
  const datePrefix = record.generatedAt.slice(0, 10);
  const labelSource = record.project || record.criteria.audience || 'prospect research';
  const path = `prospects/${datePrefix}-${slugifyRun(labelSource)}.md`;

  const yamlList = (items?: string[]): string =>
    items && items.length ? `[${items.map((v) => JSON.stringify(v)).join(', ')}]` : '[]';

  const frontmatter = [
    '---',
    'type: prospect-run',
    `actor: ${JSON.stringify(record.actor)}`,
    `generatedAt: ${JSON.stringify(record.generatedAt)}`,
    ...(record.project ? [`project: ${JSON.stringify(record.project)}`] : []),
    'source: rocketreach',
    `titles: ${yamlList(record.criteria.titles)}`,
    `regions: ${yamlList(record.criteria.regions)}`,
    `companies: ${yamlList(record.criteria.companies)}`,
    `requireWorkEmail: ${Boolean(record.criteria.requireWorkEmail)}`,
    ...(record.creditsBefore != null ? [`creditsBefore: ${record.creditsBefore}`] : []),
    ...(record.creditsAfter != null ? [`creditsAfter: ${record.creditsAfter}`] : []),
    `candidateCount: ${record.candidates.length}`,
    `enrichedCount: ${record.enriched.length}`,
    '---',
  ].join('\n');

  const candidateRows = record.candidates.length
    ? [
        '| Name | Title | Company | Location | Profile |',
        '| --- | --- | --- | --- | --- |',
        ...record.candidates.map((c) => {
          const link = c.linkedinUrl || c.profileUrl;
          const profile = link ? `[link](${link})` : '';
          return `| ${c.name} | ${c.title ?? ''} | ${c.company ?? ''} | ${c.location ?? ''} | ${profile} |`;
        }),
      ].join('\n')
    : '_No candidates found._';

  const enrichedSection = record.enriched.length
    ? [
        '',
        '## Enriched contacts',
        '',
        ...record.enriched.map((c) => {
          const emails = c.emails?.length ? c.emails.join(', ') : '—';
          return `- **${c.name}**${c.company ? ` · ${c.company}` : ''} — ${emails}`;
        }),
      ].join('\n')
    : '';

  const body = [
    frontmatter,
    '',
    `# Prospect research — ${labelSource}`,
    '',
    `> Generated ${record.generatedAt} by \`${record.actor}\` via RocketReach.`,
    record.criteria.audience ? `\n**Audience:** ${record.criteria.audience}` : '',
    '',
    '## Candidates',
    '',
    candidateRows,
    enrichedSection,
    '',
  ]
    .filter((line) => line !== undefined)
    .join('\n');

  return { path, content: body };
}
