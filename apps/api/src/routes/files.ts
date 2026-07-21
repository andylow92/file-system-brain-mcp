import { promises as fs } from 'node:fs';
import type http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { URL } from 'node:url';

import type {
  AnswerKit,
  ApiResponse,
  AuditEntry,
  Backlink,
  BlockAnchor,
  CategoryStat,
  ContextCandidate,
  EditProposal,
  FeedbackFinding,
  FileNode,
  HybridHit,
  MaintenanceFinding,
  PatchOp,
  ProposalAction,
  RankedChunk,
  ThresholdRecommendation,
  ScanFeedbackOptions,
  ScanVaultOptions,
  SchemaPack,
  SearchMatch,
  SkillCuratorFinding,
  VaultEvent,
} from '@repo/shared';
import {
  BlockNotFoundError,
  PATCH_OP_TYPES,
  SectionNotFoundError,
  applyPatchOp,
  assembleAnswerKit,
  assembleContextBundle,
  buildGraph,
  chunkNote,
  curateSkills,
  ensureNoteId,
  extractBlockAnchors,
  extractWikilinks,
  findBlock,
  findKnowledgeGaps,
  findNoteId,
  findTextMatch,
  listSkills,
  DEFAULT_DUPLICATE_THRESHOLD,
  DEFAULT_SCHEMA_PACK,
  parseFrontmatter,
  parseNote,
  reciprocalRankFusion,
  recommendThreshold,
  resolveWikilink,
  scanFeedback,
  scanVault,
  summarizeOutcomes,
} from '@repo/shared';

import type { EventBus } from '../events/eventBus.js';
import type { VaultIndex } from '../index/vaultIndex.js';
import type { AuditLog } from '../storage/auditLog.js';
import type { FileRepository, TreeNode } from '../storage/fileRepository.js';
import type { IdempotencyCache } from '../storage/idempotencyCache.js';
import type { PathResolver } from '../storage/pathResolver.js';
import { StoragePathError } from '../storage/pathResolver.js';
import type { ProposalStore } from '../storage/proposalStore.js';
import type { QuestionLog } from '../storage/questionLog.js';
import { loadSynthesisConfig, synthesizeAnswer } from '../think/synthesize.js';

interface RouteResult {
  handled: boolean;
}

interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  repository: FileRepository;
  pathResolver: PathResolver;
  auditLog: AuditLog;
  proposalStore: ProposalStore;
  questionLog: QuestionLog;
  patchIdempotency: IdempotencyCache<PatchFileResponse>;
  eventBus: EventBus;
  vaultIndex: VaultIndex;
  /** Who is making the request, from the `X-Actor` header (default `human`). */
  actor: string;
}

type ErrorCode =
  | 'invalid_path'
  | 'not_found'
  | 'validation_error'
  | 'io_error'
  | 'conflict'
  | 'stale_write'
  | 'forbidden'
  | 'bad_request';

interface ErrorResponse {
  code: ErrorCode;
  message: string;
}

interface FileResponse {
  path: string;
  content: string;
  encoding: 'utf-8';
  lastModified: string;
  etag: string;
  /** Stable note id from frontmatter `id:`, when present. */
  id?: string;
}

export interface PatchFileResponse extends FileResponse {
  /** True when the request ran in dry-run mode and no write happened. */
  dryRun: boolean;
}

export interface FileRouteDependencies {
  repository: FileRepository;
  pathResolver: PathResolver;
  auditLog: AuditLog;
  proposalStore: ProposalStore;
  questionLog: QuestionLog;
  patchIdempotency: IdempotencyCache<PatchFileResponse>;
  eventBus: EventBus;
  vaultIndex: VaultIndex;
}

const MAX_ACTOR_LENGTH = 64;

function readActor(req: http.IncomingMessage): string {
  const header = req.headers['x-actor'];
  const value = Array.isArray(header) ? header[0] : header;
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, MAX_ACTOR_LENGTH) : 'human';
}

/** Best-effort audit write: provenance must never break the underlying op. */
async function recordAudit(context: RequestContext, entry: Omit<AuditEntry, 'ts' | 'actor'>) {
  try {
    await context.auditLog.record({ actor: context.actor, ...entry });
  } catch {
    // Intentionally swallowed — the file operation has already succeeded.
  }
}

/**
 * Broadcast a live event for a successful change. Published alongside (never
 * instead of) the audit write so connected clients see the change immediately.
 * Best-effort: a publish failure must never break the underlying op.
 */
function publishVaultEvent(
  context: RequestContext,
  event: { type: VaultEvent['type']; path: string; toPath?: string; actor?: string },
) {
  try {
    context.eventBus.publish({
      type: event.type,
      path: event.path,
      ...(event.toPath ? { toPath: event.toPath } : {}),
      actor: event.actor ?? context.actor,
      ts: new Date().toISOString(),
      source: 'api',
    });
  } catch {
    // The change already succeeded; a broadcast failure is non-fatal.
  }
}

function sendJson<T>(res: http.ServerResponse, statusCode: number, body: ApiResponse<T>) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendError(res: http.ServerResponse, statusCode: number, error: ErrorResponse) {
  sendJson(res, statusCode, { success: false, error });
}

function toErrorResponse(error: unknown): { statusCode: number; error: ErrorResponse } {
  if (error instanceof StoragePathError) {
    return {
      statusCode: 400,
      error: { code: 'invalid_path', message: error.message },
    };
  }

  if (error instanceof DuplicateNoteIdError) {
    return {
      statusCode: 409,
      error: { code: 'conflict', message: error.message },
    };
  }

  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
    return {
      statusCode: 404,
      error: { code: 'not_found', message: 'Path does not exist.' },
    };
  }

  return {
    statusCode: 500,
    error: { code: 'io_error', message: 'Unexpected filesystem I/O error.' },
  };
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of req) {
    chunks.push(chunk as Uint8Array);
  }

  if (chunks.length === 0) {
    throw new Error('Request body is required');
  }

  const rawBody = Buffer.concat(chunks).toString('utf8');

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`"${fieldName}" must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`"${fieldName}" cannot be empty`);
  }

  return trimmed;
}

function requireOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`"${fieldName}" must be a string`);
  }

  return value;
}

function toEtag(content: string, lastModified: string): string {
  return createHash('sha1').update(content).update(lastModified).digest('hex');
}

async function loadFileFromContext(
  context: RequestContext,
  logicalPath: string,
): Promise<FileResponse> {
  const absolutePath = context.pathResolver.resolveMarkdownPath(logicalPath);
  const stat = await fs.stat(absolutePath);

  if (!stat.isFile()) {
    throw new StoragePathError('Markdown file does not exist');
  }

  const content = await fs.readFile(absolutePath, 'utf8');
  const lastModified = stat.mtime.toISOString();
  const id = findNoteId(content);

  return {
    path: logicalPath,
    content,
    encoding: 'utf-8',
    lastModified,
    etag: toEtag(content, lastModified),
    ...(id ? { id } : {}),
  };
}

/** Raised when two notes claim the same frontmatter `id:`. */
class DuplicateNoteIdError extends Error {
  constructor(
    public id: string,
    public paths: string[],
  ) {
    super(`Multiple notes share id "${id}": ${paths.join(', ')}`);
    this.name = 'DuplicateNoteIdError';
  }
}

/**
 * Walk the vault to find the note whose frontmatter `id:` matches. Currently
 * scans every note on each call — fine for a local single-user vault; an
 * id→path index alongside the planned chunk/IDF cache is a known follow-up.
 *
 * Throws `DuplicateNoteIdError` when two notes share the same id, since the
 * whole point of note ids is stable identity — silently resolving to one of
 * the duplicates would hide the conflict.
 */
async function findPathByNoteId(
  repository: FileRepository,
  id: string,
): Promise<string | undefined> {
  const allPaths = flattenMarkdownPaths(await repository.listTree(''));
  const matches: string[] = [];
  for (const filePath of allPaths) {
    const content = await repository.readMarkdownFile(filePath);
    if (findNoteId(content) === id) {
      matches.push(filePath);
    }
  }
  if (matches.length > 1) {
    throw new DuplicateNoteIdError(id, matches);
  }
  return matches[0];
}

/**
 * Resolve a file address (either `path=` or `id=`) into a logical path. The
 * caller passes the URL search params; we prefer `path` when both are given.
 */
async function resolveLogicalPath(
  repository: FileRepository,
  params: URLSearchParams,
): Promise<string> {
  const pathParam = params.get('path');
  if (pathParam && pathParam.trim()) {
    return requireString(pathParam, 'path');
  }
  const idParam = params.get('id');
  if (idParam && idParam.trim()) {
    const resolved = await findPathByNoteId(repository, idParam.trim());
    if (!resolved) {
      throw new StoragePathError(`No note with id "${idParam.trim()}"`);
    }
    return resolved;
  }
  throw new Error('"path" is required');
}

/** Same resolver but reading from a JSON request body's `path` / `id` fields. */
async function resolveBodyLogicalPath(
  repository: FileRepository,
  body: Record<string, unknown>,
): Promise<string> {
  const pathValue = body.path;
  if (typeof pathValue === 'string' && pathValue.trim()) {
    return requireString(pathValue, 'path');
  }
  const idValue = body.id;
  if (typeof idValue === 'string' && idValue.trim()) {
    const resolved = await findPathByNoteId(repository, idValue.trim());
    if (!resolved) {
      throw new StoragePathError(`No note with id "${idValue.trim()}"`);
    }
    return resolved;
  }
  throw new Error('"path" is required');
}

function toFileNode(node: TreeNode): FileNode {
  return {
    name: node.name,
    path: node.path,
    isDirectory: node.isDirectory,
    children: node.children?.map(toFileNode),
  };
}

async function handleGetTree({ res, url, repository }: RequestContext): Promise<void> {
  const logicalPath = url.searchParams.get('path') ?? '';
  const tree = await repository.listTree(logicalPath);
  const data: FileNode[] = tree.map(toFileNode);
  sendJson(res, 200, { success: true, data });
}

function flattenMarkdownPaths(nodes: TreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.isDirectory) {
      paths.push(...flattenMarkdownPaths(node.children ?? []));
    } else {
      paths.push(node.path);
    }
  }
  return paths;
}

async function handleGetBacklinks({ res, url, repository }: RequestContext): Promise<void> {
  const targetPath = requireString(url.searchParams.get('path'), 'path');
  const tree = await repository.listTree('');
  const allPaths = flattenMarkdownPaths(tree);

  const backlinks: Backlink[] = [];

  for (const sourcePath of allPaths) {
    if (sourcePath === targetPath) {
      continue;
    }

    const content = await repository.readMarkdownFile(sourcePath);
    const matchingLink = extractWikilinks(content).find(
      (link) => resolveWikilink(link.target, allPaths) === targetPath,
    );

    if (matchingLink) {
      backlinks.push({
        path: sourcePath,
        name: sourcePath.split('/').pop() ?? sourcePath,
        ...(matchingLink.type ? { type: matchingLink.type } : {}),
      });
    }
  }

  sendJson(res, 200, { success: true, data: backlinks });
}

async function handleGetGraph({ res, vaultIndex }: RequestContext): Promise<void> {
  // Reuse the cached index's corpus instead of re-reading the vault per call;
  // `.fsbrain/` and other dotfiles are already excluded from it.
  const documents = await vaultIndex.getDocuments();
  const graph = buildGraph(documents);
  sendJson(res, 200, { success: true, data: graph });
}

/**
 * GET /api/schema — return the vault's **schema pack**: the canonical `type:`
 * values with their colours and allowed typed relations. Static (the built-in
 * pack), so it needs no vault read; agents use it to author well-typed notes and
 * the graph view uses the colours. Validation against it surfaces as `schema`
 * maintenance findings, not here.
 */
async function handleGetSchema({ res }: RequestContext): Promise<void> {
  sendJson<{ pageTypes: SchemaPack }>(res, 200, {
    success: true,
    data: { pageTypes: DEFAULT_SCHEMA_PACK },
  });
}

interface BlockResponse {
  path: string;
  blockId: string;
  startLine: number;
  endLine: number;
  text: string;
  /** A few lines of surrounding context so the caller can place the block. */
  context: string;
  etag: string;
  lastModified: string;
  id?: string;
}

const BLOCK_CONTEXT_LINES = 2;

async function handleGetBlock(context: RequestContext): Promise<void> {
  const { res, url, repository } = context;
  const logicalPath = await resolveLogicalPath(repository, url.searchParams);
  const blockId = requireString(url.searchParams.get('block'), 'block');

  const file = await loadFileFromContext(context, logicalPath);
  const { body } = parseFrontmatter(file.content);
  const block = findBlock(body, blockId);
  if (!block) {
    sendError(res, 404, { code: 'not_found', message: `Block anchor not found: ^${blockId}` });
    return;
  }

  const bodyLines = body.split('\n');
  const before = bodyLines
    .slice(Math.max(0, block.startLine - 1 - BLOCK_CONTEXT_LINES), block.startLine - 1)
    .join('\n');
  const after = bodyLines
    .slice(block.endLine, Math.min(bodyLines.length, block.endLine + BLOCK_CONTEXT_LINES))
    .join('\n');
  const contextStr = [before, block.text, after].filter((part) => part.length > 0).join('\n');

  const data: BlockResponse = {
    path: logicalPath,
    blockId,
    startLine: block.startLine,
    endLine: block.endLine,
    text: block.text,
    context: contextStr,
    etag: file.etag,
    lastModified: file.lastModified,
    ...(file.id ? { id: file.id } : {}),
  };
  sendJson(res, 200, { success: true, data });
}

interface BlockAnchorsResponse {
  path: string;
  id?: string;
  etag: string;
  lastModified: string;
  anchors: BlockAnchor[];
}

async function handleGetBlockAnchors(context: RequestContext): Promise<void> {
  const { res, url, repository } = context;
  const logicalPath = await resolveLogicalPath(repository, url.searchParams);
  const file = await loadFileFromContext(context, logicalPath);
  const { body } = parseFrontmatter(file.content);
  const data: BlockAnchorsResponse = {
    path: logicalPath,
    ...(file.id ? { id: file.id } : {}),
    etag: file.etag,
    lastModified: file.lastModified,
    anchors: extractBlockAnchors(body),
  };
  sendJson(res, 200, { success: true, data });
}

async function handleGetFile(context: RequestContext): Promise<void> {
  const { res, url, repository } = context;
  const logicalPath = await resolveLogicalPath(repository, url.searchParams);
  const data = await loadFileFromContext(context, logicalPath);
  sendJson(res, 200, { success: true, data });
}

async function handlePutFile(context: RequestContext): Promise<void> {
  const { req, res, repository } = context;
  const body = await readJsonBody<Record<string, unknown>>(req);
  const logicalPath = requireString(body.path, 'path');
  const content = requireOptionalString(body.content, 'content') ?? '';
  const expectedEtag = requireOptionalString(body.etag, 'etag');
  const expectedLastModified = requireOptionalString(body.lastModified, 'lastModified');

  const current = await loadFileFromContext(context, logicalPath);

  if (expectedEtag && expectedEtag !== current.etag) {
    sendError(res, 409, {
      code: 'stale_write',
      message: 'Update rejected because provided etag does not match current file.',
    });
    return;
  }

  if (expectedLastModified && expectedLastModified !== current.lastModified) {
    sendError(res, 409, {
      code: 'stale_write',
      message: 'Update rejected because provided lastModified does not match current file.',
    });
    return;
  }

  await repository.updateMarkdownFile(logicalPath, content);
  const updated = await loadFileFromContext(context, logicalPath);
  await recordAudit(context, { action: 'update', path: logicalPath, etag: updated.etag });
  publishVaultEvent(context, { type: 'updated', path: logicalPath });
  sendJson(res, 200, { success: true, data: updated });
}

function requireBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`"${fieldName}" must be a boolean`);
  }
  return value;
}

type PatchOpInput = PatchOp | { type: 'ensure_id'; id?: string };
type PatchOpInputType = PatchOpInput['type'];

const PATCH_OP_INPUT_TYPES: PatchOpInputType[] = [...PATCH_OP_TYPES, 'ensure_id'];

function parsePatchOp(raw: unknown): PatchOpInput {
  if (!raw || typeof raw !== 'object') {
    throw new Error('"op" must be an object');
  }
  const op = raw as Record<string, unknown>;
  const type = requireString(op.type, 'op.type');
  if (!(PATCH_OP_INPUT_TYPES as string[]).includes(type)) {
    throw new Error(`"op.type" must be one of ${PATCH_OP_INPUT_TYPES.join(', ')}`);
  }
  if (type === 'append' || type === 'prepend') {
    const text = requireOptionalString(op.text, 'op.text') ?? '';
    return { type, text };
  }
  if (type === 'replace_section') {
    const heading = requireString(op.heading, 'op.heading');
    const body = requireOptionalString(op.body, 'op.body') ?? '';
    return { type: 'replace_section', heading, body };
  }
  if (type === 'replace_block') {
    const blockId = requireString(op.blockId, 'op.blockId');
    const body = requireOptionalString(op.body, 'op.body') ?? '';
    return { type: 'replace_block', blockId, body };
  }
  // ensure_id
  const id = requireOptionalString(op.id, 'op.id')?.trim();
  return { type: 'ensure_id', ...(id ? { id } : {}) };
}

async function handlePatchFile(context: RequestContext): Promise<void> {
  const { req, res, repository, patchIdempotency } = context;
  const body = await readJsonBody<Record<string, unknown>>(req);
  const logicalPath = await resolveBodyLogicalPath(repository, body);
  const op = parsePatchOp(body.op);
  const expectedEtag = requireOptionalString(body.etag, 'etag');
  const expectedLastModified = requireOptionalString(body.lastModified, 'lastModified');
  const dryRun = requireBoolean(body.dryRun, 'dryRun') ?? false;
  const idempotencyKey = requireOptionalString(body.idempotencyKey, 'idempotencyKey')?.trim();

  if (idempotencyKey) {
    const cached = patchIdempotency.get(idempotencyKey);
    if (cached) {
      sendJson(res, 200, { success: true, data: cached });
      return;
    }
  }

  const current = await loadFileFromContext(context, logicalPath);

  if (expectedEtag && expectedEtag !== current.etag) {
    sendError(res, 409, {
      code: 'stale_write',
      message: 'Update rejected because provided etag does not match current file.',
    });
    return;
  }

  if (expectedLastModified && expectedLastModified !== current.lastModified) {
    sendError(res, 409, {
      code: 'stale_write',
      message: 'Update rejected because provided lastModified does not match current file.',
    });
    return;
  }

  let nextContent: string;
  let unchanged = false;
  try {
    if (op.type === 'ensure_id') {
      const result = ensureNoteId(current.content, op.id ?? randomUUID());
      nextContent = result.content;
      unchanged = !result.changed;
    } else {
      nextContent = applyPatchOp(current.content, op).content;
    }
  } catch (error: unknown) {
    if (error instanceof SectionNotFoundError || error instanceof BlockNotFoundError) {
      sendError(res, 404, { code: 'not_found', message: error.message });
      return;
    }
    if (error instanceof Error) {
      sendError(res, 422, { code: 'validation_error', message: error.message });
      return;
    }
    throw error;
  }

  if (dryRun) {
    const response: PatchFileResponse = {
      path: logicalPath,
      content: nextContent,
      encoding: 'utf-8',
      lastModified: current.lastModified,
      etag: current.etag,
      ...(findNoteId(nextContent) ? { id: findNoteId(nextContent) as string } : {}),
      dryRun: true,
    };
    if (idempotencyKey) {
      patchIdempotency.set(idempotencyKey, response);
    }
    sendJson(res, 200, { success: true, data: response });
    return;
  }

  if (!unchanged) {
    await repository.updateMarkdownFile(logicalPath, nextContent);
  }
  const updated = await loadFileFromContext(context, logicalPath);
  if (!unchanged) {
    await recordAudit(context, { action: 'update', path: logicalPath, etag: updated.etag });
    publishVaultEvent(context, { type: 'updated', path: logicalPath });
  }

  const response: PatchFileResponse = { ...updated, dryRun: false };
  if (idempotencyKey) {
    patchIdempotency.set(idempotencyKey, response);
  }
  sendJson(res, 200, { success: true, data: response });
}

async function handlePostFile(context: RequestContext): Promise<void> {
  const { req, res, repository } = context;
  const body = await readJsonBody<Record<string, unknown>>(req);
  const logicalPath = requireString(body.path, 'path');
  const content = requireOptionalString(body.content, 'content') ?? '';

  try {
    await repository.createMarkdownFile(logicalPath, content);
  } catch (error: unknown) {
    if (error instanceof StoragePathError && error.message === 'File already exists') {
      sendError(res, 409, { code: 'conflict', message: error.message });
      return;
    }

    throw error;
  }

  const created = await loadFileFromContext(context, logicalPath);
  await recordAudit(context, { action: 'create', path: logicalPath, etag: created.etag });
  publishVaultEvent(context, { type: 'created', path: logicalPath });
  sendJson(res, 201, { success: true, data: created });
}

async function handlePostDir(context: RequestContext): Promise<void> {
  const { req, res, repository } = context;
  const body = await readJsonBody<Record<string, unknown>>(req);
  const logicalPath = requireString(body.path, 'path');

  await repository.createDirectory(logicalPath);
  await recordAudit(context, { action: 'create_dir', path: logicalPath });
  publishVaultEvent(context, { type: 'dir_created', path: logicalPath });
  sendJson(res, 201, { success: true, data: { path: logicalPath } });
}

async function handlePatchPath(context: RequestContext): Promise<void> {
  const { req, res, pathResolver } = context;
  const body = await readJsonBody<Record<string, unknown>>(req);
  const fromPath = requireString(body.fromPath, 'fromPath');
  const toPath = requireString(body.toPath, 'toPath');

  const sourceCandidatePath = pathResolver.resolvePath(fromPath);
  const sourceStat = await fs.stat(sourceCandidatePath);

  let sourceAbsolutePath = sourceCandidatePath;
  let destinationAbsolutePath = pathResolver.resolvePath(toPath);

  if (sourceStat.isDirectory()) {
    sourceAbsolutePath = sourceCandidatePath;
    destinationAbsolutePath = pathResolver.resolvePath(toPath);
  } else if (sourceStat.isFile()) {
    sourceAbsolutePath = pathResolver.resolveMarkdownPath(fromPath);
    destinationAbsolutePath = pathResolver.resolveMarkdownPath(toPath);
  } else {
    throw new StoragePathError('Only directories and .md files can be moved');
  }

  try {
    await fs.stat(destinationAbsolutePath);
    sendError(res, 409, {
      code: 'conflict',
      message: 'Destination already exists',
    });
    return;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.mkdir(path.dirname(destinationAbsolutePath), { recursive: true });
  await fs.rename(sourceAbsolutePath, destinationAbsolutePath);

  await recordAudit(context, { action: 'move', path: fromPath, toPath });
  publishVaultEvent(context, { type: 'moved', path: fromPath, toPath });
  sendJson(res, 200, {
    success: true,
    data: { fromPath, toPath },
  });
}

async function handleDeletePath(context: RequestContext): Promise<void> {
  const { req, res, url, repository } = context;
  const logicalPath = requireString(url.searchParams.get('path'), 'path');
  const recursiveFlag = url.searchParams.get('recursive');
  const recursive = recursiveFlag === '1' || recursiveFlag === 'true';

  if (req.headers['content-length'] && Number(req.headers['content-length']) > 0) {
    throw new Error('DELETE /api/path does not accept a request body');
  }

  await repository.deletePath(logicalPath, { recursive });
  await recordAudit(context, { action: 'delete', path: logicalPath });
  publishVaultEvent(context, { type: 'deleted', path: logicalPath });
  sendJson(res, 200, { success: true, data: { path: logicalPath, deleted: true } });
}

const DEFAULT_SEARCH_LIMIT = 50;

async function handleSearch({ res, url, vaultIndex }: RequestContext): Promise<void> {
  const query = (url.searchParams.get('q') ?? '').trim();
  const tag = (url.searchParams.get('tag') ?? '').trim().replace(/^#/, '');
  const limitParam = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_SEARCH_LIMIT;

  if (!query && !tag) {
    throw new Error('"q" or "tag" is required');
  }

  // Read from the cached index instead of the disk each query; behavior is
  // identical (same corpus, same order) but it doesn't re-read the whole vault.
  const documents = await vaultIndex.getDocuments();
  const tagLower = tag.toLowerCase();

  let matches: SearchMatch[];
  if (query) {
    // Lexical ranking (shared with `/api/hybrid-search`), then an optional tag
    // filter — equivalent to the old per-note `tag && !has → continue` guard.
    matches = rankByText(documents, query);
    if (tag) {
      matches = matches.filter((match) =>
        match.tags.some((noteTag) => noteTag.toLowerCase() === tagLower),
      );
    }
  } else {
    // Tag-only search: every note carrying the tag, with no ranking signal.
    matches = [];
    for (const { path: filePath, content } of documents) {
      const note = parseNote(content);
      if (!note.tags.some((noteTag) => noteTag.toLowerCase() === tagLower)) {
        continue;
      }
      const name = filePath.split('/').pop() ?? filePath;
      matches.push({ path: filePath, name, score: 1, snippet: '', line: 0, tags: note.tags });
    }
  }

  matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  sendJson(res, 200, { success: true, data: matches.slice(0, limit) });
}

/**
 * List the vault's **skill notes** (frontmatter `type: skill`) — procedural
 * playbooks an agent checks before starting a task. Reading one is a plain
 * `GET /api/file`; creating/updating one goes through the proposal queue, so
 * the skill library grows only with human sign-off.
 */
async function handleListSkills({ res, url, vaultIndex }: RequestContext): Promise<void> {
  const query = (url.searchParams.get('q') ?? '').trim();
  const documents = await vaultIndex.getDocuments();
  const skills = listSkills(documents, query || undefined);
  sendJson(res, 200, { success: true, data: skills });
}

/** Parse a `[0,1]` float query param; return undefined when absent/invalid. */
function parseUnitInterval(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

/** Parse a positive-integer query param; return undefined when absent/invalid. */
function parsePositiveInt(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') {
    return undefined;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * GET /api/skills/curator — a report-only pass over the vault's **skill notes**
 * (frontmatter `type: skill`). It flags skills that are structurally
 * `incomplete` (missing canonical sections), near-`duplicate_skill` pairs, and
 * `stale_skill` (unchanged for a long time). Files nothing — to act on a
 * finding, `propose_edit` the fleshed-out or consolidated skill for human
 * review. A skill with frontmatter `pinned: true` is exempt from the
 * duplicate/stale flags. Mirrors `GET /api/maintenance` (a dry preview).
 *
 * Query params: `duplicateThreshold` (0–1) and `staleAfterDays` (positive
 * integer) override the defaults; anything unparseable is ignored.
 */
async function handleSkillCuratorPreview({
  res,
  url,
  vaultIndex,
  pathResolver,
}: RequestContext): Promise<void> {
  const documents = await vaultIndex.getDocuments();
  const modifiedAt = await buildModifiedMap(
    pathResolver,
    documents.map((doc) => doc.path),
  );

  const duplicateThreshold = parseUnitInterval(url.searchParams.get('duplicateThreshold'));
  const staleAfterDays = parsePositiveInt(url.searchParams.get('staleAfterDays'));

  const findings = curateSkills(documents, {
    now: new Date().toISOString(),
    modifiedAt,
    ...(duplicateThreshold !== undefined ? { duplicateThreshold } : {}),
    ...(staleAfterDays !== undefined ? { staleAfterDays } : {}),
  });
  sendJson<{ findings: SkillCuratorFinding[] }>(res, 200, { success: true, data: { findings } });
}

async function handleSemanticSearch({ res, url, vaultIndex }: RequestContext): Promise<void> {
  const query = (url.searchParams.get('q') ?? '').trim();
  const limitParam = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 10;

  if (!query) {
    throw new Error('"q" is required');
  }

  const hits = await vaultIndex.semanticSearch(query, { limit });
  sendJson(res, 200, { success: true, data: hits });
}

const DEFAULT_HYBRID_LIMIT = 10;
// How many candidate notes each engine contributes to the fusion. A wider pool
// than the returned `limit` lets RRF reorder across engines before we truncate.
const HYBRID_CANDIDATE_LIMIT = 50;
// The semantic engine ranks *chunks*, and several top chunks can share one long
// note; oversample the chunk pool so that, after collapsing to one chunk per
// note, semantic still feeds RRF a full pool of distinct candidate notes.
const HYBRID_CHUNK_OVERSAMPLE = 4;

/**
 * The lexical engine: rank notes by full-text (body) + filename substring match,
 * highest occurrence count first. Shared by `/api/search` (which slices it for
 * its response) and `/api/hybrid-search` (which feeds it into RRF), so the two
 * endpoints can never drift on how they score keyword relevance.
 */
function rankByText(
  documents: readonly { path: string; content: string }[],
  query: string,
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (const { path: filePath, content } of documents) {
    const note = parseNote(content);
    const name = filePath.split('/').pop() ?? filePath;
    const textMatch = findTextMatch(note.body, query);
    const nameMatches = name.toLowerCase().includes(query.toLowerCase());
    if (!textMatch && !nameMatches) {
      continue;
    }
    matches.push({
      path: filePath,
      name,
      score: (textMatch?.count ?? 0) + (nameMatches ? 1 : 0),
      snippet: textMatch?.snippet ?? '',
      line: textMatch?.line ?? 0,
      tags: note.tags,
    });
  }
  matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return matches;
}

/** First non-empty body line of a note (heading marker stripped) — a fallback
 * display snippet for hits that have no exact match line and no semantic chunk. */
function firstBodyLine(content: string): string {
  const { body } = parseNote(content);
  for (const raw of body.split('\n')) {
    const text = raw
      .replace(/^#{1,6}\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) {
      return text.slice(0, 200);
    }
  }
  return '';
}

/**
 * Hybrid retrieval: fuse the lexical (keyword) and semantic (relevance) rankings
 * with Reciprocal Rank Fusion. Each engine ranks notes by a non-comparable
 * score, so we fuse by rank position and keep the best snippet from whichever
 * engine matched (preferring the exact lexical line for legibility).
 */
async function handleHybridSearch({ res, url, vaultIndex }: RequestContext): Promise<void> {
  const query = (url.searchParams.get('q') ?? '').trim();
  const limitParam = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_HYBRID_LIMIT;

  if (!query) {
    throw new Error('"q" is required');
  }

  const documents = await vaultIndex.getDocuments();

  // Lexical ranking: notes ordered by full-text + filename match.
  const lexical = rankByText(documents, query).slice(0, HYBRID_CANDIDATE_LIMIT);

  // Semantic ranking: collapse the per-chunk ranking to the best chunk per note,
  // preserving order (the index returns chunks already sorted by score).
  // Oversample chunks, then keep the top HYBRID_CANDIDATE_LIMIT *distinct* notes
  // so semantic feeds RRF a pool comparable to lexical even on long-note vaults.
  const ranked = await vaultIndex.rankedChunks(query, {
    limit: HYBRID_CANDIDATE_LIMIT * HYBRID_CHUNK_OVERSAMPLE,
  });
  const bestChunk = new Map<string, RankedChunk>();
  for (const chunk of ranked) {
    if (!bestChunk.has(chunk.path)) {
      bestChunk.set(chunk.path, chunk);
      if (bestChunk.size >= HYBRID_CANDIDATE_LIMIT) {
        break;
      }
    }
  }

  // Fuse by rank (scales aren't comparable across engines).
  const fused = reciprocalRankFusion([
    { keys: lexical.map((match) => match.path), label: 'text' },
    { keys: [...bestChunk.keys()], label: 'semantic' },
  ]);

  const lexicalByPath = new Map(lexical.map((match) => [match.path, match]));
  const contentByPath = new Map(documents.map((doc) => [doc.path, doc.content]));

  const hits: HybridHit[] = fused.slice(0, limit).map((item) => {
    const lex = lexicalByPath.get(item.key);
    const sem = bestChunk.get(item.key);
    const content = contentByPath.get(item.key) ?? '';
    const semSnippet = sem ? sem.text.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    const useLexicalSnippet = Boolean(lex?.snippet);
    // Prefer the exact lexical line, then the semantic chunk; fall back to the
    // note's first line so a filename-only hit never renders a blank preview.
    const snippet = (useLexicalSnippet ? lex!.snippet : semSnippet) || firstBodyLine(content);
    return {
      path: item.key,
      name: item.key.split('/').pop() ?? item.key,
      score: Number(item.score.toFixed(4)),
      snippet,
      ...(!useLexicalSnippet && sem?.heading ? { heading: sem.heading } : {}),
      line: lex?.line ?? 0,
      tags: lex?.tags ?? parseNote(content).tags,
      sources: item.sources as ('text' | 'semantic')[],
    };
  });

  sendJson(res, 200, { success: true, data: hits });
}

const DEFAULT_CONTEXT_BUDGET = 2000;
const CONTEXT_MATCH_LIMIT = 12;
const FOCUS_CHUNK_LIMIT = 4;
const NEIGHBOR_EXCERPT_CHARS = 280;

/** Build focus-note + backlink neighbor passages for a context bundle. */
function buildContextNeighbors(
  documents: readonly { path: string; content: string }[],
  focusPath: string,
): ContextCandidate[] {
  const neighbors: ContextCandidate[] = [];

  // The focus note itself, chunked — its most relevant chunks may already be
  // matches (de-duped away); the rest provide surrounding context.
  const focusDoc = documents.find((doc) => doc.path === focusPath);
  if (focusDoc) {
    for (const chunk of chunkNote(focusPath, focusDoc.content).slice(0, FOCUS_CHUNK_LIMIT)) {
      neighbors.push({
        path: focusPath,
        ...(chunk.heading ? { heading: chunk.heading } : {}),
        text: chunk.text,
        score: 0,
      });
    }
  }

  // Notes that link to the focus note, each as a short excerpt — the neighbor
  // graph around the note the agent is centered on.
  const allPaths = documents.map((doc) => doc.path);
  for (const doc of documents) {
    if (doc.path === focusPath) {
      continue;
    }
    const linksHere = extractWikilinks(doc.content).some(
      (link) => resolveWikilink(link.target, allPaths) === focusPath,
    );
    if (!linksHere) {
      continue;
    }
    const excerpt = (chunkNote(doc.path, doc.content)[0]?.text ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, NEIGHBOR_EXCERPT_CHARS);
    if (excerpt) {
      neighbors.push({ path: doc.path, text: excerpt, score: 0 });
    }
  }

  return neighbors;
}

async function handleGetContext({ res, url, vaultIndex }: RequestContext): Promise<void> {
  const query = (url.searchParams.get('q') ?? '').trim();
  if (!query) {
    throw new Error('"q" is required');
  }

  const focusPath = (url.searchParams.get('path') ?? '').trim();
  const budgetParam = Number(url.searchParams.get('budget'));
  const tokenBudget =
    Number.isFinite(budgetParam) && budgetParam > 0
      ? Math.floor(budgetParam)
      : DEFAULT_CONTEXT_BUDGET;

  // (1) The most relevant passages for the query, with full chunk text.
  const ranked = await vaultIndex.rankedChunks(query, { limit: CONTEXT_MATCH_LIMIT });
  const matches: ContextCandidate[] = ranked.map((chunk) => ({
    path: chunk.path,
    ...(chunk.heading ? { heading: chunk.heading } : {}),
    text: chunk.text,
    score: chunk.score,
  }));

  // (2) When focused on a note, add it + its backlinks as neighbor context.
  const neighbors = focusPath
    ? buildContextNeighbors(await vaultIndex.getDocuments(), focusPath)
    : undefined;

  // (3) De-dupe + pack within the token budget (pure, tested in @repo/shared).
  const bundle = assembleContextBundle({
    query,
    ...(focusPath ? { focusPath } : {}),
    tokenBudget,
    matches,
    neighbors,
  });

  sendJson(res, 200, { success: true, data: bundle });
}

const DEFAULT_THINK_BUDGET = 2000;
// How many top fused notes feed the answer kit as cited passages.
const THINK_MATCH_LIMIT = 8;
// Oversample semantic chunks so collapsing to one-per-note still fills the pool.
const THINK_CHUNK_OVERSAMPLE = 4;

/**
 * `think` — a grounded, cited answer kit. Runs **hybrid retrieval** (fuse the
 * lexical + semantic rankings by RRF so neither exact keyword nor conceptual
 * matches are missed), assembles a token-budgeted context bundle from the fused
 * passages, and returns numbered citations + an **offline gap analysis** via the
 * pure `assembleAnswerKit`. Stays fully offline by default; only when an
 * OpenRouter key is configured server-side *and* the request opts in
 * (`synthesize=1`) does it also include a synthesized prose `answer` — and a
 * synthesis failure never fails the offline kit.
 */
async function handleThink(context: RequestContext): Promise<void> {
  const { res, url, vaultIndex, questionLog, actor } = context;
  const query = (url.searchParams.get('q') ?? '').trim();
  if (!query) {
    throw new Error('"q" is required');
  }

  const focusPath = (url.searchParams.get('path') ?? '').trim();
  const budgetParam = Number(url.searchParams.get('budget'));
  const tokenBudget =
    Number.isFinite(budgetParam) && budgetParam > 0
      ? Math.floor(budgetParam)
      : DEFAULT_THINK_BUDGET;

  const documents = await vaultIndex.getDocuments();

  // Hybrid match selection: fuse lexical + semantic by rank, then bring in each
  // fused note's full passage text (the semantic chunk, or — for a lexical-only
  // note — its leading chunk, so a keyword-only hit is never dropped).
  const lexical = rankByText(documents, query).slice(0, HYBRID_CANDIDATE_LIMIT);
  const ranked = await vaultIndex.rankedChunks(query, {
    limit: THINK_MATCH_LIMIT * THINK_CHUNK_OVERSAMPLE,
  });
  // Collapse to the best chunk per note. The `rankedChunks` limit above already
  // bounds this map, and `fused.slice(0, THINK_MATCH_LIMIT)` bounds the final
  // pool — so, unlike `handleHybridSearch` (which serves a much wider list and
  // caps distinct notes at HYBRID_CANDIDATE_LIMIT), no explicit cap is needed here.
  const bestChunk = new Map<string, RankedChunk>();
  for (const chunk of ranked) {
    if (!bestChunk.has(chunk.path)) {
      bestChunk.set(chunk.path, chunk);
    }
  }

  const fused = reciprocalRankFusion([
    { keys: lexical.map((match) => match.path), label: 'text' },
    { keys: [...bestChunk.keys()], label: 'semantic' },
  ]);

  const contentByPath = new Map(documents.map((doc) => [doc.path, doc.content]));
  const matches: ContextCandidate[] = [];
  for (const item of fused.slice(0, THINK_MATCH_LIMIT)) {
    const sem = bestChunk.get(item.key);
    if (sem) {
      matches.push({
        path: sem.path,
        ...(sem.heading ? { heading: sem.heading } : {}),
        text: sem.text,
        score: sem.score,
      });
      continue;
    }
    // Lexical-only note: include its leading chunk. Score 0 is deliberate — a
    // keyword/filename hit carries no comparable relevance signal, so it does
    // not count toward coverage *strength* (`gaps.weakCoverage` / `topScore`).
    // Its terms still register as covered via `uncoveredTerms`, so a pure
    // keyword hit can read as "weak coverage" yet leave no term uncovered.
    const lead = chunkNote(item.key, contentByPath.get(item.key) ?? '')[0];
    if (lead?.text) {
      matches.push({
        path: item.key,
        ...(lead.heading ? { heading: lead.heading } : {}),
        text: lead.text,
        score: 0,
      });
    }
  }

  // When focused on a note, add it + its backlinks as neighbor context.
  const neighbors = focusPath ? buildContextNeighbors(documents, focusPath) : undefined;

  const bundle = assembleContextBundle({
    query,
    ...(focusPath ? { focusPath } : {}),
    tokenBudget,
    matches,
    neighbors,
  });

  const kit = assembleAnswerKit(query, bundle);

  // Persist the question + its gap signal to the question log so recurring
  // unanswerable questions become visible (`GET /api/questions`). Best-effort:
  // a logging failure must never fail the answer.
  try {
    await questionLog.record({
      actor,
      query,
      weakCoverage: kit.gaps.weakCoverage,
      uncoveredTerms: kit.gaps.uncoveredTerms,
    });
  } catch {
    // Ignore — the kit is the deliverable, the log is telemetry.
  }

  // Optional, opt-in, offline-by-default synthesis (only with a server-side key).
  let answer: string | undefined;
  const synthesizeParam = (url.searchParams.get('synthesize') ?? '').toLowerCase();
  if (synthesizeParam === '1' || synthesizeParam === 'true') {
    const config = loadSynthesisConfig();
    if (config) {
      try {
        answer = await synthesizeAnswer({ config, kit });
      } catch {
        // A synthesis failure must never fail the offline answer kit.
        answer = undefined;
      }
    }
  }

  sendJson<AnswerKit & { answer?: string }>(res, 200, {
    success: true,
    data: { ...kit, ...(answer ? { answer } : {}) },
  });
}

const DEFAULT_QUESTIONS_LIMIT = 50;

/**
 * The question log: recent `think` questions with their gap signal, plus the
 * **recurring knowledge gaps** distilled from the whole log — terms that keep
 * going uncovered across questions. A recurring gap is a demand-driven prompt
 * for what note to write (or propose) next.
 */
async function handleGetQuestions({ res, url, questionLog }: RequestContext): Promise<void> {
  const limitParam = Number(url.searchParams.get('limit'));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_QUESTIONS_LIMIT;
  const minCountParam = Number(url.searchParams.get('minCount'));
  const minCount = Number.isFinite(minCountParam) && minCountParam > 0 ? minCountParam : undefined;

  // Gaps are distilled from the *whole* log (chronological), independent of the
  // entry-list limit — recurrence shouldn't vanish because the page is short.
  const all = await questionLog.list();
  const gaps = findKnowledgeGaps([...all].reverse(), minCount ? { minCount } : {});

  sendJson(res, 200, { success: true, data: { entries: all.slice(0, limit), gaps } });
}

async function handleGetAudit({ res, url, auditLog }: RequestContext): Promise<void> {
  const pathFilter = url.searchParams.get('path')?.trim() || undefined;
  const limitParam = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50;

  const entries = await auditLog.list({ path: pathFilter, limit });
  sendJson(res, 200, { success: true, data: entries });
}

const PROPOSAL_ACTIONS: ProposalAction[] = ['create', 'update', 'delete'];

async function handleCreateProposal(context: RequestContext): Promise<void> {
  const { req, res, proposalStore, actor } = context;
  const body = await readJsonBody<Record<string, unknown>>(req);
  const action = requireString(body.action, 'action') as ProposalAction;
  if (!PROPOSAL_ACTIONS.includes(action)) {
    throw new Error('"action" must be create, update, or delete');
  }
  const logicalPath = requireString(body.path, 'path');
  const content = requireOptionalString(body.content, 'content');
  const baseEtag = requireOptionalString(body.baseEtag, 'baseEtag');
  const note = requireOptionalString(body.note, 'note');
  const category = requireOptionalString(body.category, 'category');

  if ((action === 'create' || action === 'update') && content === undefined) {
    throw new Error('"content" is required for create and update proposals');
  }

  const proposal = await proposalStore.create({
    actor,
    action,
    path: logicalPath,
    category,
    content,
    baseEtag,
    note,
  });
  publishVaultEvent(context, { type: 'proposal_created', path: logicalPath });
  sendJson(res, 201, { success: true, data: proposal });
}

async function handleListProposals({ res, url, proposalStore }: RequestContext): Promise<void> {
  const statusParam = url.searchParams.get('status')?.trim();
  const status =
    statusParam === 'pending' || statusParam === 'approved' || statusParam === 'rejected'
      ? statusParam
      : undefined;
  const proposals = await proposalStore.list({ status });
  sendJson(res, 200, { success: true, data: proposals });
}

export interface ProposalStatsResult {
  /** Per-category approve/reject tallies, most-resolved first. */
  categories: CategoryStat[];
  /** Bounded threshold nudges the scans should adopt (empty when no signal). */
  recommendations: ThresholdRecommendation[];
}

/**
 * GET /api/proposals/stats — review-queue learning. Tally the proposal store's
 * approve/reject outcomes per category and derive any bounded threshold nudges
 * (today: the dream-cycle duplicate-detection cosine, which the maintenance
 * scan adopts on its own). Read-only — it files nothing and resolves nothing.
 */
async function handleProposalStats({ res, proposalStore }: RequestContext): Promise<void> {
  const proposals = await proposalStore.list();
  const categories = summarizeOutcomes(proposals);
  const duplicate = categories.find((stat) => stat.category === 'maintenance:duplicate');
  const dupRec = duplicate ? recommendThreshold(duplicate, DEFAULT_DUPLICATE_THRESHOLD) : null;
  const recommendations = dupRec ? [dupRec] : [];
  sendJson<ProposalStatsResult>(res, 200, {
    success: true,
    data: { categories, recommendations },
  });
}

/** Apply an approved proposal to the vault, recording it as the proposer's edit. */
async function applyProposal(context: RequestContext, proposal: EditProposal): Promise<void> {
  const { repository, res } = context;

  if (proposal.action === 'delete') {
    // Share the stale-write contract with `update`: don't delete a file that
    // materially changed since the proposal was made.
    if (proposal.baseEtag) {
      const current = await loadFileFromContext(context, proposal.path);
      if (proposal.baseEtag !== current.etag) {
        sendError(res, 409, {
          code: 'stale_write',
          message:
            'The file changed since this proposal was created; re-propose against the latest.',
        });
        throw new ProposalAborted();
      }
    }
    await repository.deletePath(proposal.path, { recursive: false });
    await recordAuditAs(context, proposal.actor, { action: 'delete', path: proposal.path });
    publishVaultEvent(context, { type: 'deleted', path: proposal.path, actor: proposal.actor });
    return;
  }

  const content = proposal.content ?? '';

  if (proposal.action === 'create') {
    try {
      await repository.createMarkdownFile(proposal.path, content);
    } catch (error: unknown) {
      if (error instanceof StoragePathError && error.message === 'File already exists') {
        sendError(res, 409, { code: 'conflict', message: error.message });
        throw new ProposalAborted();
      }
      throw error;
    }
  } else {
    // update — reject if the file changed since the proposal was based on it.
    const current = await loadFileFromContext(context, proposal.path);
    if (proposal.baseEtag && proposal.baseEtag !== current.etag) {
      sendError(res, 409, {
        code: 'stale_write',
        message: 'The file changed since this proposal was created; re-propose against the latest.',
      });
      throw new ProposalAborted();
    }
    await repository.updateMarkdownFile(proposal.path, content);
  }

  const updated = await loadFileFromContext(context, proposal.path);
  await recordAuditAs(context, proposal.actor, {
    action: proposal.action,
    path: proposal.path,
    etag: updated.etag,
  });
  publishVaultEvent(context, {
    type: proposal.action === 'create' ? 'created' : 'updated',
    path: proposal.path,
    actor: proposal.actor,
  });
}

/** Signals that a response was already sent while aborting a proposal apply. */
class ProposalAborted extends Error {}

/** Best-effort audit write attributed to a specific actor (the proposer). */
async function recordAuditAs(
  context: RequestContext,
  actor: string,
  entry: Omit<AuditEntry, 'ts' | 'actor'>,
) {
  try {
    await context.auditLog.record({ actor, ...entry });
  } catch {
    // Provenance is best-effort; the file operation already succeeded.
  }
}

async function handleResolveProposal(context: RequestContext): Promise<void> {
  const { req, res, proposalStore, actor } = context;

  // Resolution is a human action. This guard rejects the obvious case (an
  // `agent:` actor approving its own work); it is convention-level, not
  // airtight, because `X-Actor` is unauthenticated — true enforcement needs
  // authn/z (intentionally out of scope for this local, single-user tool).
  if (/^agent:/i.test(actor)) {
    sendError(res, 403, { code: 'forbidden', message: 'Only a human can resolve proposals.' });
    return;
  }

  const body = await readJsonBody<Record<string, unknown>>(req);
  const id = requireString(body.id, 'id');
  const decision = requireString(body.decision, 'decision');
  if (decision !== 'approve' && decision !== 'reject') {
    throw new Error('"decision" must be approve or reject');
  }

  const proposal = await proposalStore.get(id);
  if (!proposal) {
    sendError(res, 404, { code: 'not_found', message: 'Proposal not found.' });
    return;
  }
  if (proposal.status !== 'pending') {
    sendError(res, 409, {
      code: 'conflict',
      message: `Proposal already ${proposal.status}.`,
    });
    return;
  }

  if (decision === 'approve') {
    try {
      await applyProposal(context, proposal);
    } catch (error: unknown) {
      if (error instanceof ProposalAborted) {
        return; // response already sent
      }
      throw error;
    }
  }

  const resolved = await proposalStore.resolve(id, {
    status: decision === 'approve' ? 'approved' : 'rejected',
    resolvedBy: actor,
  });
  publishVaultEvent(context, { type: 'proposal_resolved', path: proposal.path });
  sendJson(res, 200, { success: true, data: resolved });
}

/** The actor every maintenance-filed proposal is attributed to. */
const MAINTENANCE_ACTOR = 'agent:maintenance';

export interface MaintenanceScanResult {
  findings: MaintenanceFinding[];
  proposalsFiled: EditProposal[];
  /**
   * The duplicate-threshold nudge applied this run, derived from the review
   * queue's approve/reject history. Absent when there isn't enough resolved
   * signal to tune (the scan used the default threshold).
   */
  tuning?: ThresholdRecommendation;
}

/** Broadcast a `proposal_created` event for a maintenance-filed proposal. */
function publishMaintenanceProposal(eventBus: EventBus, logicalPath: string): void {
  try {
    eventBus.publish({
      type: 'proposal_created',
      path: logicalPath,
      actor: MAINTENANCE_ACTOR,
      ts: new Date().toISOString(),
      source: 'api',
    });
  } catch {
    // The proposal already persisted; a broadcast failure is non-fatal.
  }
}

/**
 * The current etag of a note, computed exactly as `loadFileFromContext` does
 * (`sha1(content + lastModified)`), or `undefined` if the file can't be read.
 * Used to stamp a maintenance `update` proposal with a `baseEtag` so approving a
 * stale one 409s instead of clobbering edits made between the scan and approval.
 */
async function currentNoteEtag(
  pathResolver: PathResolver,
  logicalPath: string,
): Promise<string | undefined> {
  try {
    const absolutePath = pathResolver.resolveMarkdownPath(logicalPath);
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      return undefined;
    }
    const content = await fs.readFile(absolutePath, 'utf8');
    return toEtag(content, stat.mtime.toISOString());
  } catch {
    return undefined;
  }
}

/**
 * Build a `logical path → last-modified ISO` map from each note's mtime, used to
 * feed the maintenance scan's freshness ("stale but load-bearing") detection.
 * A path that can't be stat'd is simply omitted, so it is never flagged stale.
 */
async function buildModifiedMap(
  pathResolver: PathResolver,
  paths: readonly string[],
): Promise<Record<string, string>> {
  const modifiedAt: Record<string, string> = {};
  for (const logicalPath of paths) {
    try {
      const stat = await fs.stat(pathResolver.resolveMarkdownPath(logicalPath));
      if (stat.isFile()) {
        modifiedAt[logicalPath] = stat.mtime.toISOString();
      }
    } catch {
      // Unreadable/missing — leave it out; the scan won't judge its freshness.
    }
  }
  return modifiedAt;
}

/**
 * Run the dream-cycle maintenance scan over the cached corpus and file each
 * actionable finding's suggestion as an edit proposal (attributed to
 * `agent:maintenance`) for human review in the Review tab. Resolution stays
 * human-only — nothing here applies an edit.
 *
 * Idempotent: a suggestion whose `action`+`path` already matches a still-relevant
 * proposal — **pending** (awaiting review) or **rejected** (the human already
 * said no) — is skipped, so re-running never spams the Review queue and never
 * re-surfaces a suggestion the human declined (which would otherwise reappear
 * every `MAINTENANCE_INTERVAL_MS`). An `update` suggestion (the duplicate
 * cross-link, whose `content` is a full-note snapshot taken at scan time) is
 * filed with the target's current `baseEtag`, so approving it after the note
 * changed is rejected (`409 stale_write`) by `applyProposal` rather than silently
 * overwriting the edit. Shared by `POST /api/maintenance/scan` and the optional
 * `MAINTENANCE_INTERVAL_MS` scheduler in `createServer`.
 */
export async function runMaintenanceScan(deps: {
  vaultIndex: VaultIndex;
  proposalStore: ProposalStore;
  eventBus: EventBus;
  pathResolver: PathResolver;
  options?: ScanVaultOptions;
}): Promise<MaintenanceScanResult> {
  const documents = await deps.vaultIndex.getDocuments();

  // Read the proposal store once — it drives both the re-file guard below and
  // the review-queue threshold tuning here.
  const existing = await deps.proposalStore.list();

  // Auto-tune the duplicate-detection threshold from past review outcomes,
  // unless the caller pinned one explicitly. If the human keeps rejecting
  // duplicate cross-links the bar rises (fewer, more confident matches); if
  // they keep approving it falls. Below the sample floor `recommendThreshold`
  // returns null, so a fresh vault simply uses the default. Resolution stays
  // human-only — this only changes how many duplicates are surfaced.
  let duplicateThreshold = deps.options?.duplicateThreshold;
  let tuning: ThresholdRecommendation | null = null;
  if (duplicateThreshold === undefined) {
    const dupStat = summarizeOutcomes(existing).find(
      (stat) => stat.category === 'maintenance:duplicate',
    );
    tuning = dupStat ? recommendThreshold(dupStat, DEFAULT_DUPLICATE_THRESHOLD) : null;
    duplicateThreshold = tuning?.recommended ?? DEFAULT_DUPLICATE_THRESHOLD;
  }

  // Per-note mtimes drive freshness ("stale but load-bearing") detection.
  const modifiedAt = await buildModifiedMap(
    deps.pathResolver,
    documents.map((doc) => doc.path),
  );

  const findings = scanVault(documents, {
    now: new Date().toISOString(),
    modifiedAt,
    schemaPack: DEFAULT_SCHEMA_PACK,
    ...deps.options,
    duplicateThreshold,
  });

  // Block re-filing against pending + rejected proposals. Approved ones aren't
  // blocked: the fix already landed, so the finding resolves on its own (a
  // created stub now exists; an approved cross-link makes the pair already
  // linked, so `scanVault` reports it without a suggestion).
  const blockedKeys = new Set(
    existing
      .filter((proposal) => proposal.status === 'pending' || proposal.status === 'rejected')
      .map((proposal) => `${proposal.action}:${proposal.path}`),
  );

  const proposalsFiled: EditProposal[] = [];
  for (const finding of findings) {
    const { suggestion } = finding;
    if (!suggestion) {
      continue;
    }
    const key = `${suggestion.action}:${suggestion.path}`;
    if (blockedKeys.has(key)) {
      continue;
    }
    // Guard against two findings suggesting the same action+path within one scan.
    blockedKeys.add(key);

    // Stamp an `update` with the target's current etag so a stale approval is
    // rejected instead of clobbering edits. (A `create` needs none — it 409s on
    // "File already exists".)
    const baseEtag =
      suggestion.action === 'update'
        ? await currentNoteEtag(deps.pathResolver, suggestion.path)
        : undefined;

    const proposal = await deps.proposalStore.create({
      actor: MAINTENANCE_ACTOR,
      action: suggestion.action,
      path: suggestion.path,
      category: `maintenance:${finding.kind}`,
      ...(suggestion.content !== undefined ? { content: suggestion.content } : {}),
      ...(baseEtag ? { baseEtag } : {}),
      note: suggestion.note,
    });
    publishMaintenanceProposal(deps.eventBus, suggestion.path);
    proposalsFiled.push(proposal);
  }

  return { findings, proposalsFiled, ...(tuning ? { tuning } : {}) };
}

/** GET /api/maintenance — a dry preview: scan the cached corpus, file nothing. */
async function handleMaintenancePreview({
  res,
  vaultIndex,
  pathResolver,
}: RequestContext): Promise<void> {
  const documents = await vaultIndex.getDocuments();
  const modifiedAt = await buildModifiedMap(
    pathResolver,
    documents.map((doc) => doc.path),
  );
  const findings = scanVault(documents, {
    now: new Date().toISOString(),
    modifiedAt,
    schemaPack: DEFAULT_SCHEMA_PACK,
  });
  sendJson<{ findings: MaintenanceFinding[] }>(res, 200, { success: true, data: { findings } });
}

/** POST /api/maintenance/scan — scan and file each actionable finding as a proposal. */
async function handleMaintenanceScan(context: RequestContext): Promise<void> {
  const { res, vaultIndex, proposalStore, eventBus, pathResolver } = context;
  const result = await runMaintenanceScan({ vaultIndex, proposalStore, eventBus, pathResolver });
  sendJson<MaintenanceScanResult>(res, 200, { success: true, data: result });
}

const FEEDBACK_ACTOR = 'agent:feedback-loop';

export interface FeedbackScanResult {
  findings: FeedbackFinding[];
  proposalsFiled: EditProposal[];
}

/** Broadcast a `proposal_created` event for a feedback-loop-filed proposal. */
function publishFeedbackProposal(eventBus: EventBus, logicalPath: string): void {
  try {
    eventBus.publish({
      type: 'proposal_created',
      path: logicalPath,
      actor: FEEDBACK_ACTOR,
      ts: new Date().toISOString(),
      source: 'api',
    });
  } catch {
    // The proposal already persisted; a broadcast failure is non-fatal.
  }
}

/**
 * Run the outreach feedback scan over the cached corpus and file each distilled
 * lesson as an edit proposal (attributed to `agent:feedback-loop`) that grows a
 * channel playbook, for human review in the Review tab. Resolution stays
 * human-only — nothing here applies an edit, and no draft is ever posted or sent.
 *
 * Idempotent on two levels: a suggestion whose `action`+`path` already matches a
 * still-relevant proposal (**pending** or **rejected**) is skipped, and
 * `scanFeedback` itself omits any pairing whose lesson marker is already present
 * in the target playbook — so re-running never spams the queue nor re-files a
 * lesson the human already approved. An `update` carries the target's current
 * `baseEtag`, so approving it after the playbook changed is rejected
 * (`409 stale_write`) by `applyProposal` rather than silently overwriting the
 * edit. Shared by `POST /api/feedback/scan` and the optional `FEEDBACK_INTERVAL_MS`
 * scheduler in `createServer`.
 */
export async function runFeedbackScan(deps: {
  vaultIndex: VaultIndex;
  proposalStore: ProposalStore;
  eventBus: EventBus;
  pathResolver: PathResolver;
  options?: ScanFeedbackOptions;
}): Promise<FeedbackScanResult> {
  const documents = await deps.vaultIndex.getDocuments();
  const findings = scanFeedback(documents, deps.options);

  // Block re-filing against pending + rejected proposals (approved ones already
  // landed; the lesson's marker then suppresses the finding on its own).
  const existing = await deps.proposalStore.list();
  const blockedKeys = new Set(
    existing
      .filter((proposal) => proposal.status === 'pending' || proposal.status === 'rejected')
      .map((proposal) => `${proposal.action}:${proposal.path}`),
  );

  const proposalsFiled: EditProposal[] = [];
  for (const finding of findings) {
    const { suggestion } = finding;
    if (!suggestion) {
      continue;
    }
    const key = `${suggestion.action}:${suggestion.path}`;
    if (blockedKeys.has(key)) {
      continue;
    }
    // Guard against two findings targeting the same playbook within one scan.
    blockedKeys.add(key);

    // Stamp an `update` with the target's current etag so a stale approval is
    // rejected instead of clobbering edits. (A `create` 409s on "already exists".)
    const baseEtag =
      suggestion.action === 'update'
        ? await currentNoteEtag(deps.pathResolver, suggestion.path)
        : undefined;

    const proposal = await deps.proposalStore.create({
      actor: FEEDBACK_ACTOR,
      action: suggestion.action,
      path: suggestion.path,
      category: `feedback:${finding.channel}`,
      content: suggestion.content,
      ...(baseEtag ? { baseEtag } : {}),
      note: suggestion.note,
    });
    publishFeedbackProposal(deps.eventBus, suggestion.path);
    proposalsFiled.push(proposal);
  }

  return { findings, proposalsFiled };
}

/** GET /api/feedback — a dry preview: scan the cached corpus, file nothing. */
async function handleFeedbackPreview({ res, vaultIndex }: RequestContext): Promise<void> {
  const documents = await vaultIndex.getDocuments();
  const findings = scanFeedback(documents);
  sendJson<{ findings: FeedbackFinding[] }>(res, 200, { success: true, data: { findings } });
}

/** POST /api/feedback/scan — scan and file each lesson as a review proposal. */
async function handleFeedbackScan(context: RequestContext): Promise<void> {
  const { res, vaultIndex, proposalStore, eventBus, pathResolver } = context;
  const result = await runFeedbackScan({ vaultIndex, proposalStore, eventBus, pathResolver });
  sendJson<FeedbackScanResult>(res, 200, { success: true, data: result });
}

async function executeHandler(
  context: RequestContext,
  handler: (ctx: RequestContext) => Promise<void>,
): Promise<void> {
  try {
    await handler(context);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('"')) {
      sendError(context.res, 422, { code: 'validation_error', message: error.message });
      return;
    }

    if (error instanceof Error && error.message.includes('Request body')) {
      sendError(context.res, 400, { code: 'bad_request', message: error.message });
      return;
    }

    const mapped = toErrorResponse(error);
    sendError(context.res, mapped.statusCode, mapped.error);
  }
}

export async function handleFileRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  dependencies: FileRouteDependencies,
): Promise<RouteResult> {
  if (!req.url || !req.method) {
    return { handled: false };
  }

  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const context: RequestContext = { req, res, url, actor: readActor(req), ...dependencies };

  if (req.method === 'GET' && url.pathname === '/api/tree') {
    await executeHandler(context, handleGetTree);
    return { handled: true };
  }

  if (req.method === 'GET' && url.pathname === '/api/file') {
    await executeHandler(context, handleGetFile);
    return { handled: true };
  }

  if (req.method === 'GET' && url.pathname === '/api/backlinks') {
    await executeHandler(context, handleGetBacklinks);
    return { handled: true };
  }

  if (req.method === 'GET' && url.pathname === '/api/graph') {
    await executeHandler(context, handleGetGraph);
    return { handled: true };
  }

  if (req.method === 'GET' && url.pathname === '/api/schema') {
    await executeHandler(context, handleGetSchema);
    return { handled: true };
  }

  if (req.method === 'GET' && url.pathname === '/api/block') {
    await executeHandler(context, handleGetBlock);
    return { handled: true };
  }

  if (req.method === 'GET' && url.pathname === '/api/block-anchors') {
    await executeHandler(context, handleGetBlockAnchors);
    return { handled: true };
  }

  if (req.method === 'GET' && url.pathname === '/api/search') {
    await executeHandler(context, handleSearch);
    return { handled: true };
  }

  if (req.method === 'GET' && url.pathname === '/api/skills') {
    await executeHandler(context, handleListSkills);
    return { handled: true };
  }

  if (req.method === 'GET' && url.pathname === '/api/skills/curator') {
    await executeHandler(context, handleSkillCuratorPreview);
    return { handled: true };
  }

  if (req.method === 'GET' && url.pathname === '/api/semantic-search') {
    await executeHandler(context, handleSemanticSearch);
    return { handled: true };
  }

  if (req.method === 'GET' && url.pathname === '/api/hybrid-search') {
    await executeHandler(context, handleHybridSearch);
    return { handled: true };
  }

  if (req.method === 'GET' && url.pathname === '/api/context') {
    await executeHandler(context, handleGetContext);
    return { handled: true };
  }

  if (req.method === 'GET' && url.pathname === '/api/think') {
    await executeHandler(context, handleThink);
    return { handled: true };
  }

  if (req.method === 'GET' && url.pathname === '/api/audit') {
    await executeHandler(context, handleGetAudit);
    return { handled: true };
  }

  if (req.method === 'GET' && url.pathname === '/api/questions') {
    await executeHandler(context, handleGetQuestions);
    return { handled: true };
  }

  if (req.method === 'GET' && url.pathname === '/api/maintenance') {
    await executeHandler(context, handleMaintenancePreview);
    return { handled: true };
  }

  if (req.method === 'POST' && url.pathname === '/api/maintenance/scan') {
    await executeHandler(context, handleMaintenanceScan);
    return { handled: true };
  }

  if (req.method === 'GET' && url.pathname === '/api/feedback') {
    await executeHandler(context, handleFeedbackPreview);
    return { handled: true };
  }

  if (req.method === 'POST' && url.pathname === '/api/feedback/scan') {
    await executeHandler(context, handleFeedbackScan);
    return { handled: true };
  }

  if (req.method === 'GET' && url.pathname === '/api/proposals/stats') {
    await executeHandler(context, handleProposalStats);
    return { handled: true };
  }

  if (req.method === 'GET' && url.pathname === '/api/proposals') {
    await executeHandler(context, handleListProposals);
    return { handled: true };
  }

  if (req.method === 'POST' && url.pathname === '/api/proposals') {
    await executeHandler(context, handleCreateProposal);
    return { handled: true };
  }

  if (req.method === 'POST' && url.pathname === '/api/proposals/resolve') {
    await executeHandler(context, handleResolveProposal);
    return { handled: true };
  }

  if (req.method === 'PUT' && url.pathname === '/api/file') {
    await executeHandler(context, handlePutFile);
    return { handled: true };
  }

  if (req.method === 'PATCH' && url.pathname === '/api/file') {
    await executeHandler(context, handlePatchFile);
    return { handled: true };
  }

  if (req.method === 'POST' && url.pathname === '/api/file') {
    await executeHandler(context, handlePostFile);
    return { handled: true };
  }

  if (req.method === 'POST' && url.pathname === '/api/dir') {
    await executeHandler(context, handlePostDir);
    return { handled: true };
  }

  if (req.method === 'PATCH' && url.pathname === '/api/path') {
    await executeHandler(context, handlePatchPath);
    return { handled: true };
  }

  if (req.method === 'DELETE' && url.pathname === '/api/path') {
    await executeHandler(context, handleDeletePath);
    return { handled: true };
  }

  return { handled: false };
}
