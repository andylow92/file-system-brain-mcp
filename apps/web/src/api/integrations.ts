import type { ApiResponse, RocketReachAccountStatus, RocketReachStatus } from '@repo/shared';

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

export function getRocketReachStatus(): Promise<RocketReachStatus> {
  return requestJson<RocketReachStatus>('/api/integrations/rocketreach', {
    method: 'GET',
    headers: {},
  });
}

export function updateRocketReach(patch: {
  enabled?: boolean;
  /** A string sets the key; `null` removes it; omit to leave unchanged. */
  apiKey?: string | null;
}): Promise<RocketReachStatus> {
  return requestJson<RocketReachStatus>('/api/integrations/rocketreach', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

export function testRocketReach(): Promise<{
  connected: boolean;
  account: RocketReachAccountStatus;
}> {
  return requestJson<{ connected: boolean; account: RocketReachAccountStatus }>(
    '/api/integrations/rocketreach/test',
    { method: 'POST' },
  );
}
