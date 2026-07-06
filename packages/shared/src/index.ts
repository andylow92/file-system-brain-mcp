export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

export interface FileContent {
  path: string;
  content: string;
  encoding: 'utf-8';
  lastModified?: string;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export interface HealthResponse {
  status: 'ok';
  contentRoot: string;
  timestamp: string;
}

export interface Backlink {
  /** Logical path of the note that links to the target. */
  path: string;
  /** Display name (basename) of the linking note. */
  name: string;
  /**
   * Typed relation extracted from the wikilink, e.g. `[[Target|rel:supports]]`
   * → `"supports"`. Absent when the link did not carry a `rel:` marker.
   */
  type?: string;
}

export type AuditAction = 'create' | 'update' | 'move' | 'delete' | 'create_dir';

/** A single recorded change to the vault, for human-visible provenance. */
export interface AuditEntry {
  /** ISO timestamp of the change. */
  ts: string;
  /** Who made the change, e.g. `human` or `agent:mcp`. */
  actor: string;
  action: AuditAction;
  /** Logical path affected (source path for moves). */
  path: string;
  /** Destination path, for moves. */
  toPath?: string;
  /** Resulting content etag, when applicable. */
  etag?: string;
}

/** A single full-text / tag search hit. */
export interface SearchMatch {
  path: string;
  /** Basename of the matched note. */
  name: string;
  /** Higher means more relevant (occurrence count, or 1 for tag-only hits). */
  score: number;
  /** Excerpt of the first matching line (empty for tag-only hits). */
  snippet: string;
  /** 1-based line of the first match (0 for tag-only hits). */
  line: number;
  /** Tags declared by the note. */
  tags: string[];
}

/**
 * A live vault change broadcast to connected clients (web UI) over SSE, so the
 * human sees what an agent (or another process) does the moment it happens.
 *
 * Emitted from two sources:
 * - `api`   — published by a route handler alongside its audit write, on every
 *             successful mutation or proposal event.
 * - `watch` — published by the filesystem watcher for out-of-band edits (a
 *             direct file edit, a `git` operation, another process) so they
 *             surface even though they never went through the API.
 */
export type VaultEventType =
  | 'created'
  | 'updated'
  | 'moved'
  | 'deleted'
  | 'dir_created'
  | 'proposal_created'
  | 'proposal_resolved';

export interface VaultEvent {
  type: VaultEventType;
  /** Logical path affected (source path for moves). */
  path: string;
  /** Destination path, for moves. */
  toPath?: string;
  /** Who caused the change, e.g. `human`, `agent:mcp`, or `external` for watch. */
  actor: string;
  /** ISO timestamp of the change. */
  ts: string;
  /** Where the event originated. */
  source: 'api' | 'watch';
}

export type ProposalAction = 'create' | 'update' | 'delete';
export type ProposalStatus = 'pending' | 'approved' | 'rejected';

/**
 * A proposed edit awaiting human review. Lets agents suggest changes the human
 * approves/rejects, instead of writing to the vault directly — the provenance
 * trust loop.
 */
export interface EditProposal {
  id: string;
  /** ISO timestamp the proposal was created. */
  ts: string;
  /** Who proposed it, e.g. `agent:mcp`. */
  actor: string;
  action: ProposalAction;
  path: string;
  /**
   * Optional grouping key for review-queue learning, set by the filer (e.g.
   * `maintenance:duplicate`, `feedback:x`). When absent (older proposals,
   * ad-hoc `propose_edit`s) the proposal-stats helper falls back to
   * `actor:action`, so the field is purely additive and back-compatible.
   */
  category?: string;
  /** Proposed content for `create` / `update`. */
  content?: string;
  /** Etag the proposal was based on (used to detect a stale `update`). */
  baseEtag?: string;
  /** Optional rationale from the proposer. */
  note?: string;
  status: ProposalStatus;
  /** ISO timestamp the proposal was approved/rejected. */
  resolvedTs?: string;
  /** Human actor who resolved it. */
  resolvedBy?: string;
}

export * from './blocks.js';
export * from './context.js';
export * from './embeddings.js';
export * from './feedback.js';
export * from './graph.js';
export * from './hybrid.js';
export * from './maintenance.js';
export * from './markdown.js';
export * from './noteId.js';
export * from './patch.js';
export * from './proposalStats.js';
export * from './questions.js';
export * from './retrievalEval.js';
export * from './schema.js';
export * from './search.js';
export * from './semantic.js';
export * from './skills.js';
export * from './think.js';
