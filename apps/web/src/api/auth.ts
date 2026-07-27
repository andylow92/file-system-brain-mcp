import type {
  ApiResponse,
  AuthAgentRule,
  AuthDefaultAccess,
  AuthStatusResponse,
  AuthTestResponse,
} from '@repo/shared';

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
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
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

export function getAuthStatus(): Promise<AuthStatusResponse> {
  return requestJson<AuthStatusResponse>('/api/auth', { method: 'GET', headers: {} });
}

export interface AuthSettingsPatch {
  enabled?: boolean;
  trustDomain?: string | null;
  audience?: string;
  allowLoopback?: boolean;
  jwks?: { inline?: string; file?: string; url?: string } | null;
  defaultAccess?: AuthDefaultAccess;
  agents?: AuthAgentRule[];
}

export function updateAuthSettings(patch: AuthSettingsPatch): Promise<AuthStatusResponse> {
  return requestJson<AuthStatusResponse>('/api/auth', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

export function testAuthToken(token: string): Promise<AuthTestResponse> {
  return requestJson<AuthTestResponse>('/api/auth/test', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}
