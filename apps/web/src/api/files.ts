import type {
  ApiResponse,
  AuditEntry,
  Backlink,
  DocumentFormat,
  EditProposal,
  FileNode,
  GraphData,
  HybridHit,
  MaintenanceFinding,
  ProposalStatus,
  SearchMatch,
  SemanticHit,
} from '@repo/shared';

export interface RemoteFile {
  path: string;
  content: string;
  encoding: 'utf-8';
  lastModified: string;
  etag: string;
  /** `markdown` (editable) or read-only `html`, whose `content` is the verbatim source. */
  format: DocumentFormat;
  mimeType: string;
}

interface PathMutationResponse {
  fromPath?: string;
  toPath?: string;
  path?: string;
}

interface DeletePathResponse {
  path: string;
  deleted: boolean;
}

class ApiClientError extends Error {
  code: string;

  constructor(message: string, code = 'unknown_error') {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
  }
}

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const payload = (await response.json()) as ApiResponse<T>;

  if (!response.ok || !payload.success) {
    const error = payload.success
      ? { code: 'unknown_error', message: `Request failed with status ${response.status}` }
      : payload.error;
    throw new ApiClientError(error.message, error.code);
  }

  return payload.data;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown API error';
}

export async function fetchTree(path = ''): Promise<FileNode[]> {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  return requestJson<FileNode[]>(`/api/tree${query}`, { method: 'GET', headers: {} });
}

export async function fetchFile(path: string): Promise<RemoteFile> {
  return requestJson<RemoteFile>(`/api/file?path=${encodeURIComponent(path)}`, {
    method: 'GET',
    headers: {},
  });
}

export async function fetchBacklinks(path: string): Promise<Backlink[]> {
  return requestJson<Backlink[]>(`/api/backlinks?path=${encodeURIComponent(path)}`, {
    method: 'GET',
    headers: {},
  });
}

export async function fetchGraph(): Promise<GraphData> {
  return requestJson<GraphData>('/api/graph', { method: 'GET', headers: {} });
}

export async function searchNotes(params: {
  query?: string;
  tag?: string;
  limit?: number;
}): Promise<SearchMatch[]> {
  const search = new URLSearchParams();
  if (params.query) {
    search.set('q', params.query);
  }
  if (params.tag) {
    search.set('tag', params.tag);
  }
  if (params.limit) {
    search.set('limit', String(params.limit));
  }

  return requestJson<SearchMatch[]>(`/api/search?${search.toString()}`, {
    method: 'GET',
    headers: {},
  });
}

export async function semanticSearch(params: {
  query: string;
  limit?: number;
}): Promise<SemanticHit[]> {
  const search = new URLSearchParams({ q: params.query });
  if (params.limit) {
    search.set('limit', String(params.limit));
  }

  return requestJson<SemanticHit[]>(`/api/semantic-search?${search.toString()}`, {
    method: 'GET',
    headers: {},
  });
}

export async function hybridSearch(params: {
  query: string;
  limit?: number;
}): Promise<HybridHit[]> {
  const search = new URLSearchParams({ q: params.query });
  if (params.limit) {
    search.set('limit', String(params.limit));
  }

  return requestJson<HybridHit[]>(`/api/hybrid-search?${search.toString()}`, {
    method: 'GET',
    headers: {},
  });
}

export async function fetchAudit(
  params: { path?: string; limit?: number } = {},
): Promise<AuditEntry[]> {
  const search = new URLSearchParams();
  if (params.path) {
    search.set('path', params.path);
  }
  if (params.limit) {
    search.set('limit', String(params.limit));
  }

  const query = search.toString();
  return requestJson<AuditEntry[]>(`/api/audit${query ? `?${query}` : ''}`, {
    method: 'GET',
    headers: {},
  });
}

export async function fetchProposals(status?: ProposalStatus): Promise<EditProposal[]> {
  const query = status ? `?status=${status}` : '';
  return requestJson<EditProposal[]>(`/api/proposals${query}`, { method: 'GET', headers: {} });
}

export async function resolveProposal(
  id: string,
  decision: 'approve' | 'reject',
): Promise<EditProposal> {
  return requestJson<EditProposal>('/api/proposals/resolve', {
    method: 'POST',
    body: JSON.stringify({ id, decision }),
  });
}

export interface MaintenanceScanResult {
  findings: MaintenanceFinding[];
  proposalsFiled: EditProposal[];
}

/**
 * Kick the dream-cycle maintenance scan: it finds vault-hygiene problems and
 * files each actionable one as a proposal (actor `agent:maintenance`) for human
 * review. Idempotent — re-running never re-files an already-open proposal.
 */
export async function runMaintenance(): Promise<MaintenanceScanResult> {
  return requestJson<MaintenanceScanResult>('/api/maintenance/scan', { method: 'POST' });
}

export async function updateFile(params: {
  path: string;
  content: string;
  etag?: string;
  lastModified?: string;
}): Promise<RemoteFile> {
  return requestJson<RemoteFile>('/api/file', {
    method: 'PUT',
    body: JSON.stringify(params),
  });
}

export async function createFile(path: string, content = ''): Promise<RemoteFile> {
  return requestJson<RemoteFile>('/api/file', {
    method: 'POST',
    body: JSON.stringify({ path, content }),
  });
}

export async function createDirectory(path: string): Promise<PathMutationResponse> {
  return requestJson<PathMutationResponse>('/api/dir', {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
}

export async function renamePath(fromPath: string, toPath: string): Promise<PathMutationResponse> {
  return requestJson<PathMutationResponse>('/api/path', {
    method: 'PATCH',
    body: JSON.stringify({ fromPath, toPath }),
  });
}

export async function deletePath(path: string, recursive = false): Promise<DeletePathResponse> {
  const query = new URLSearchParams({ path, recursive: String(recursive) }).toString();
  return requestJson<DeletePathResponse>(`/api/path?${query}`, {
    method: 'DELETE',
    headers: {},
  });
}
