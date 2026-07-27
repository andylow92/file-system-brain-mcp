import type http from 'node:http';

import {
  resolveAgentAccess,
  type ApiResponse,
  type AuthSettings,
  type AuthStatusResponse,
  type AuthTestResponse,
} from '@repo/shared';

import { AuthVerifyError, type AuthGate, type SvidVerifier } from '../auth/verifier.js';
import { AuthConfigError, type AuthSettingsPatch, type AuthStore } from '../storage/authStore.js';

/**
 * Settings routes for the optional SPIFFE auth layer, mirroring the
 * integrations pattern: the API owns the state, and the web dialog + docs are
 * thin clients over these three endpoints.
 *
 *   GET  /api/auth       → status (safe summary + "who am I" for the caller)
 *   PUT  /api/auth       → update settings
 *   POST /api/auth/test  → dry-run verification of a pasted JWT-SVID
 *
 * The generic auth guard has already run before these handlers. On top of it,
 * `PUT` enforces one extra invariant that must hold even while auth is
 * DISABLED: only loopback (or, once enabled, a verified `admin` identity) may
 * change auth settings. Without this, anyone who can reach an exposed
 * unauthenticated vault could enable auth against their own trust domain and
 * lock the owner out.
 */

interface RouteResult {
  handled: boolean;
}

export interface AuthRouteDependencies {
  authStore: AuthStore;
  verifier: SvidVerifier;
  gate: AuthGate;
}

function sendJson<T>(res: http.ServerResponse, statusCode: number, body: ApiResponse<T>) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendError(res: http.ServerResponse, statusCode: number, code: string, message: string) {
  sendJson(res, statusCode, { success: false, error: { code, message } });
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T | null> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Uint8Array);
  }
  if (chunks.length === 0) {
    return {} as T;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    return null;
  }
}

function toStatus(settings: AuthSettings, gate: AuthGate): AuthStatusResponse {
  const configured = Boolean(settings.trustDomain);
  const jwksSource = settings.jwks?.inline
    ? ('inline' as const)
    : settings.jwks?.file
      ? ('file' as const)
      : settings.jwks?.url
        ? ('url' as const)
        : undefined;
  const callerKind = gate.spiffeId ? 'spiffe' : gate.loopback ? 'loopback' : 'open';
  const isOwnerView = gate.loopback || gate.access === 'admin';
  return {
    enabled: settings.enabled,
    configured,
    state: settings.enabled ? 'enabled' : 'disabled',
    ...(settings.trustDomain ? { trustDomain: settings.trustDomain } : {}),
    audience: settings.audience,
    allowLoopback: settings.allowLoopback,
    defaultAccess: settings.defaultAccess,
    ...(jwksSource ? { jwksSource } : {}),
    bearerReady: Boolean(settings.jwks),
    // The full rule list names other agents; only the owner surface sees it.
    ...(isOwnerView ? { agents: settings.agents } : {}),
    caller: {
      kind: callerKind,
      ...(gate.spiffeId ? { spiffeId: gate.spiffeId } : {}),
      ...(gate.enabled || gate.spiffeId ? { access: gate.access } : {}),
    },
  };
}

export async function handleAuthRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: AuthRouteDependencies,
): Promise<RouteResult> {
  const { authStore, verifier, gate } = deps;

  if (url.pathname === '/api/auth' && req.method === 'GET') {
    const settings = await authStore.getAuth();
    sendJson(res, 200, { success: true, data: toStatus(settings, gate) });
    return { handled: true };
  }

  if (url.pathname === '/api/auth' && req.method === 'PUT') {
    // The guard already demanded `admin` when auth is enabled. While auth is
    // disabled the guard waves everything through — so the local-only rule
    // here is what keeps an exposed-but-unconfigured vault's auth settings
    // out of remote hands.
    if (!gate.loopback && !gate.spiffeId) {
      sendError(
        res,
        403,
        'local_only',
        'Auth settings can only be changed from the machine running the vault (loopback) until auth is enabled with an admin identity.',
      );
      return { handled: true };
    }
    const body = await readJsonBody<AuthSettingsPatch>(req);
    if (body === null) {
      sendError(res, 400, 'bad_request', 'Request body must be valid JSON.');
      return { handled: true };
    }
    try {
      const next = await authStore.setAuth(body);
      sendJson(res, 200, { success: true, data: toStatus(next, gate) });
    } catch (error) {
      if (error instanceof AuthConfigError) {
        sendError(res, 400, 'validation_error', error.message);
      } else {
        sendError(res, 500, 'io_error', 'Failed to persist auth settings.');
      }
    }
    return { handled: true };
  }

  if (url.pathname === '/api/auth/test' && req.method === 'POST') {
    const body = await readJsonBody<{ token?: unknown }>(req);
    if (body === null || typeof body.token !== 'string' || !body.token.trim()) {
      sendError(res, 400, 'bad_request', 'Provide { "token": "<JWT-SVID>" } to test.');
      return { handled: true };
    }
    const settings = await authStore.getAuth();
    if (!settings.trustDomain) {
      sendError(res, 409, 'setup_required', 'Configure a trust domain before testing tokens.');
      return { handled: true };
    }
    let data: AuthTestResponse;
    try {
      const spiffeId = await verifier.verifyBearer(body.token.trim(), settings);
      data = {
        valid: true,
        spiffeId,
        access: resolveAgentAccess(spiffeId, settings.agents, settings.defaultAccess),
      };
    } catch (error) {
      data = {
        valid: false,
        reason:
          error instanceof AuthVerifyError
            ? error.message
            : 'Verification failed for an unexpected reason.',
      };
    }
    sendJson(res, 200, { success: true, data });
    return { handled: true };
  }

  return { handled: false };
}
