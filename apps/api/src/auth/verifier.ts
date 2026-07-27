import type http from 'node:http';
import { promises as fs } from 'node:fs';
import type { TLSSocket } from 'node:tls';

import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

import {
  accessAllows,
  parseSpiffeId,
  resolveAgentAccess,
  type ApiResponse,
  type AuthAccess,
  type AuthSettings,
} from '@repo/shared';

import type { AuthStore } from '../storage/authStore.js';

/**
 * Request-time enforcement for the optional SPIFFE auth layer.
 *
 * Behavior contract (see docs/distributed-auth.md):
 * - Auth disabled (default): every request passes untouched — exactly the
 *   pre-auth behavior of this API.
 * - Auth enabled: loopback requests stay exempt while `allowLoopback` is on
 *   (the local web UI and the embedded MCP keep working with zero setup);
 *   every other request must present a verifiable SPIFFE identity — an mTLS
 *   client certificate (X.509-SVID) or a `Bearer` JWT-SVID — in the
 *   configured trust domain.
 * - On success the verified SPIFFE ID *replaces* the self-declared `X-Actor`
 *   header, so the audit log, live events, and proposals attribute the write
 *   to a cryptographic identity that cannot be spoofed by a remote client.
 */

/** Asymmetric algorithms only — never accept HS* against a public JWKS. */
const ALLOWED_JWT_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
];

/** Small skew allowance so freshly minted short-TTL SVIDs never flap. */
const CLOCK_TOLERANCE_SECONDS = 30;

export type AuthErrorCode =
  | 'unauthorized'
  | 'invalid_token'
  | 'wrong_trust_domain'
  | 'not_spiffe_subject'
  | 'not_authorized'
  | 'read_only'
  | 'admin_required'
  | 'auth_misconfigured';

export class AuthVerifyError extends Error {
  constructor(
    message: string,
    public code: AuthErrorCode,
    /** HTTP status this error maps to. */
    public status: number,
  ) {
    super(message);
    this.name = 'AuthVerifyError';
  }
}

/** True for 127.0.0.0/8 and ::1 (including the IPv4-mapped form). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const bare = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return bare === '::1' || bare.startsWith('127.');
}

export interface SvidVerifier {
  /**
   * Verify a JWT-SVID bearer token against the given settings. Returns the
   * verified SPIFFE ID; throws `AuthVerifyError` with a specific code for
   * every rejection path.
   */
  verifyBearer(token: string, settings: AuthSettings): Promise<string>;
}

/**
 * Build a verifier with a JWKS cache that survives across requests: inline
 * sources are parsed once per content, file sources re-read only when their
 * mtime changes (SPIRE and spiffe-helper rotate bundles in place), and URL
 * sources use jose's remote set, which handles its own refetching.
 */
export function createSvidVerifier(): SvidVerifier {
  const inlineCache = new Map<string, JWTVerifyGetKey>();
  const fileCache = new Map<string, { mtimeMs: number; resolver: JWTVerifyGetKey }>();
  const urlCache = new Map<string, JWTVerifyGetKey>();

  async function resolveKeySet(settings: AuthSettings): Promise<JWTVerifyGetKey> {
    const jwks = settings.jwks;
    if (!jwks) {
      throw new AuthVerifyError(
        'Bearer tokens cannot be verified: no JWKS is configured for this vault (mTLS only). Configure a JWKS source in auth settings.',
        'auth_misconfigured',
        503,
      );
    }
    try {
      if (jwks.inline) {
        let resolver = inlineCache.get(jwks.inline);
        if (!resolver) {
          resolver = createLocalJWKSet(JSON.parse(jwks.inline));
          inlineCache.clear();
          inlineCache.set(jwks.inline, resolver);
        }
        return resolver;
      }
      if (jwks.file) {
        const stat = await fs.stat(jwks.file);
        const cached = fileCache.get(jwks.file);
        if (cached && cached.mtimeMs === stat.mtimeMs) {
          return cached.resolver;
        }
        const raw = await fs.readFile(jwks.file, 'utf8');
        const resolver = createLocalJWKSet(JSON.parse(raw));
        fileCache.clear();
        fileCache.set(jwks.file, { mtimeMs: stat.mtimeMs, resolver });
        return resolver;
      }
      if (jwks.url) {
        let resolver = urlCache.get(jwks.url);
        if (!resolver) {
          resolver = createRemoteJWKSet(new URL(jwks.url));
          urlCache.clear();
          urlCache.set(jwks.url, resolver);
        }
        return resolver;
      }
    } catch (error) {
      if (error instanceof AuthVerifyError) throw error;
      throw new AuthVerifyError(
        'The configured JWKS could not be loaded — check the auth settings on the server.',
        'auth_misconfigured',
        503,
      );
    }
    throw new AuthVerifyError(
      'The configured JWKS could not be loaded — check the auth settings on the server.',
      'auth_misconfigured',
      503,
    );
  }

  async function verifyBearer(token: string, settings: AuthSettings): Promise<string> {
    const keySet = await resolveKeySet(settings);
    let subject: string | undefined;
    try {
      const { payload } = await jwtVerify(token, keySet, {
        audience: settings.audience,
        algorithms: ALLOWED_JWT_ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['sub', 'aud', 'exp'],
      });
      subject = payload.sub;
    } catch (error) {
      if (error instanceof AuthVerifyError) throw error;
      // jose's message names the exact claim/signature failure; safe to relay.
      const detail = error instanceof Error ? error.message : 'verification failed';
      throw new AuthVerifyError(`Invalid bearer token: ${detail}`, 'invalid_token', 401);
    }
    const spiffe = subject ? parseSpiffeId(subject) : null;
    if (!spiffe) {
      throw new AuthVerifyError(
        'Token subject is not a SPIFFE ID (expected sub like spiffe://<trust-domain>/<path>).',
        'not_spiffe_subject',
        401,
      );
    }
    if (spiffe.trustDomain !== settings.trustDomain) {
      throw new AuthVerifyError(
        `Identity ${spiffe.id} is outside this vault's trust domain (${settings.trustDomain}).`,
        'wrong_trust_domain',
        401,
      );
    }
    return spiffe.id;
  }

  return { verifyBearer };
}

/**
 * Extract a verified SPIFFE ID from an mTLS client certificate, when the
 * connection is TLS, the server requested certs, and Node verified the chain
 * against the configured client CA. Returns `undefined` when the connection
 * carries no usable certificate (the caller falls through to bearer auth).
 * Exported for unit tests (minting real client certificates needs openssl).
 */
export function peerSpiffeId(
  req: http.IncomingMessage,
  settings: AuthSettings,
): string | undefined {
  const socket = req.socket as TLSSocket;
  if (!socket.encrypted || typeof socket.getPeerCertificate !== 'function') return undefined;
  if (!socket.authorized) return undefined;
  const cert = socket.getPeerCertificate();
  const san = cert?.subjectaltname;
  if (!san) return undefined;
  // subjectaltname is a comma-separated list like `URI:spiffe://…, DNS:host`.
  for (const entry of san.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed.startsWith('URI:')) continue;
    const parsed = parseSpiffeId(trimmed.slice('URI:'.length));
    if (parsed && parsed.trustDomain === settings.trustDomain) {
      return parsed.id;
    }
  }
  return undefined;
}

/** Outcome of the per-request gate. When `allowed` is false, a response was sent. */
export interface AuthGate {
  allowed: boolean;
  /** Whether auth is currently enabled (routes use this for redaction rules). */
  enabled: boolean;
  /** Whether the request arrived over loopback. */
  loopback: boolean;
  /** Verified SPIFFE identity, present only for SVID-authenticated requests. */
  spiffeId?: string;
  /** Effective access. Loopback/disabled requests act as the owner (`admin`). */
  access: AuthAccess;
}

export interface AuthGuardOptions {
  authStore: AuthStore;
  verifier: SvidVerifier;
  /** Injectable for tests that need to simulate a non-loopback caller. */
  isLoopback?: (req: http.IncomingMessage) => boolean;
}

/**
 * The access level a request needs. Reads (GET/HEAD — every read in this API
 * uses GET) need `read`; anything else needs `readwrite`; changing the auth
 * config itself needs `admin`. `POST /api/auth/test` is a dry-run verification
 * with read semantics despite its method.
 */
export function requiredAccess(method: string, pathname: string): AuthAccess {
  if (pathname === '/api/auth' && method !== 'GET' && method !== 'HEAD') return 'admin';
  if (pathname === '/api/auth/test') return 'read';
  return method === 'GET' || method === 'HEAD' ? 'read' : 'readwrite';
}

export type AuthGuard = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
) => Promise<AuthGate>;

export function createAuthGuard(options: AuthGuardOptions): AuthGuard {
  const { authStore, verifier } = options;
  const isLoopback =
    options.isLoopback ??
    ((req: http.IncomingMessage) => isLoopbackAddress(req.socket.remoteAddress));

  function deny(res: http.ServerResponse, error: AuthVerifyError): void {
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
    if (error.status === 401) {
      headers['WWW-Authenticate'] = 'Bearer realm="fsbrain"';
    }
    const body: ApiResponse<never> = {
      success: false,
      error: { code: error.code, message: error.message },
    };
    res.writeHead(error.status, headers);
    res.end(JSON.stringify(body));
  }

  return async function guard(req, res, pathname): Promise<AuthGate> {
    const loopback = isLoopback(req);
    const settings = await authStore.getAuth();

    if (!settings.enabled) {
      return { allowed: true, enabled: false, loopback, access: 'admin' };
    }

    if (loopback && settings.allowLoopback) {
      // The owner's own machine: the local web UI, curl on the box, and the
      // embedded MCP server. This is also the lockout-recovery path.
      return { allowed: true, enabled: true, loopback: true, access: 'admin' };
    }

    let spiffeId: string | undefined;
    try {
      spiffeId = peerSpiffeId(req, settings);
      if (!spiffeId) {
        const header = req.headers.authorization;
        const token =
          typeof header === 'string' && header.startsWith('Bearer ')
            ? header.slice('Bearer '.length).trim()
            : undefined;
        if (!token) {
          throw new AuthVerifyError(
            'This vault requires a SPIFFE identity: send a JWT-SVID as `Authorization: Bearer …` or connect with an mTLS client certificate.',
            'unauthorized',
            401,
          );
        }
        spiffeId = await verifier.verifyBearer(token, settings);
      }

      const access = resolveAgentAccess(spiffeId, settings.agents, settings.defaultAccess);
      if (access === null) {
        throw new AuthVerifyError(
          `Identity ${spiffeId} verified, but this vault grants it no access.`,
          'not_authorized',
          403,
        );
      }
      const needed = requiredAccess(req.method ?? 'GET', pathname);
      if (!accessAllows(access, needed)) {
        throw new AuthVerifyError(
          needed === 'admin'
            ? `Changing auth settings requires admin access; ${spiffeId} has ${access}.`
            : `Identity ${spiffeId} has read-only access to this vault.`,
          needed === 'admin' ? 'admin_required' : 'read_only',
          403,
        );
      }

      // The verified identity becomes the actor for every downstream consumer
      // (audit log, live events, proposals) — a remote client's self-declared
      // X-Actor is discarded rather than trusted.
      req.headers['x-actor'] = spiffeId;
      return { allowed: true, enabled: true, loopback, spiffeId, access };
    } catch (error) {
      const verifyError =
        error instanceof AuthVerifyError
          ? error
          : new AuthVerifyError('Authentication failed.', 'unauthorized', 401);
      deny(res, verifyError);
      return { allowed: false, enabled: true, loopback, access: 'read' };
    }
  };
}
