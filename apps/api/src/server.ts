import { readFileSync, unwatchFile, watchFile } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type tls from 'node:tls';
import { URL } from 'node:url';

import type { ApiResponse, HealthResponse } from '@repo/shared';

import { createAuthGuard, createSvidVerifier, isLoopbackAddress } from './auth/verifier.js';
import { ensureContentRoot, loadConfig } from './config.js';
import { createEventBus } from './events/eventBus.js';
import { handleEventStream } from './events/sse.js';
import { createVaultWatcher } from './events/watcher.js';
import { createVaultIndex } from './index/vaultIndex.js';
import {
  handleFileRoutes,
  runFeedbackScan,
  runMaintenanceScan,
  type PatchFileResponse,
} from './routes/files.js';
import { handleAuthRoutes } from './routes/auth.js';
import { createAuditLog } from './storage/auditLog.js';
import { createAuthStore } from './storage/authStore.js';
import { createFileRepository } from './storage/fileRepository.js';
import { createIdempotencyCache } from './storage/idempotencyCache.js';
import { createPathResolver } from './storage/pathResolver.js';
import { createProposalStore } from './storage/proposalStore.js';
import { createQuestionLog } from './storage/questionLog.js';

export { loadConfig, ensureContentRoot, defaultContentRoot } from './config.js';
export type { ServerConfig } from './config.js';

/** PEM material for optional HTTPS/mTLS, already read from disk. */
export interface TlsMaterial {
  cert: string;
  key: string;
  /** When set, clients may present certificates verified against this CA (X.509-SVID auth). */
  clientCa?: string;
}

export interface CreateServerOptions {
  /**
   * Serve HTTPS (and, with `clientCa`, accept mTLS client certificates)
   * instead of plain HTTP. Left unset by the embedded MCP server and tests —
   * `startServer` populates it from the FSBRAIN_TLS_* environment variables.
   */
  tls?: TlsMaterial;
  /**
   * Override loopback detection for the auth guard. Production leaves this
   * unset (the socket's remote address decides); tests inject it to simulate
   * remote callers without real cross-host networking.
   */
  authIsLoopback?: (req: http.IncomingMessage) => boolean;
}

export function createServer(
  config = loadConfig(),
  options: CreateServerOptions = {},
): http.Server {
  ensureContentRoot(config.contentRoot);
  const pathResolver = createPathResolver(config.contentRoot);
  const repository = createFileRepository(pathResolver);
  const auditLog = createAuditLog(config.contentRoot);
  const proposalStore = createProposalStore(config.contentRoot);
  const questionLog = createQuestionLog(config.contentRoot);
  // Optional SPIFFE auth (Settings → Vault access). Disabled by default: the
  // guard waves every request through untouched until the owner enables it.
  const authStore = createAuthStore(config.contentRoot);
  const svidVerifier = createSvidVerifier();
  const isLoopbackRequest =
    options.authIsLoopback ??
    ((req: http.IncomingMessage) => isLoopbackAddress(req.socket.remoteAddress));
  const authGuard = createAuthGuard({
    authStore,
    verifier: svidVerifier,
    isLoopback: isLoopbackRequest,
  });
  const patchIdempotency = createIdempotencyCache<PatchFileResponse>();
  const eventBus = createEventBus();
  // Surface out-of-band edits (direct file writes, git, another process) so the
  // human's view stays live even for changes that never hit the API.
  const watcher = createVaultWatcher({ contentRoot: config.contentRoot, eventBus });
  // A cached retrieval index so search / semantic / context don't re-read the
  // whole vault per query. It subscribes to the same bus, so any write (API or
  // out-of-band) invalidates it and the next query rebuilds — never stale.
  const vaultIndex = createVaultIndex({ repository, eventBus, contentRoot: config.contentRoot });

  // Optional "dream cycle": when MAINTENANCE_INTERVAL_MS is a positive number,
  // periodically scan the vault for hygiene problems (broken links, orphans,
  // near-duplicates) and file each fix as a proposal for human review. Off by
  // default (unset); on-demand scanning is always available via the endpoints.
  const maintenanceIntervalMs = Number(process.env.MAINTENANCE_INTERVAL_MS);
  let maintenanceTimer: NodeJS.Timeout | undefined;
  if (Number.isFinite(maintenanceIntervalMs) && maintenanceIntervalMs > 0) {
    maintenanceTimer = setInterval(() => {
      void runMaintenanceScan({ vaultIndex, proposalStore, eventBus, pathResolver }).catch(() => {
        // Best-effort: a scheduled scan must never crash the server.
      });
    }, maintenanceIntervalMs);
    // Don't keep the process (or a test's event loop) alive just for the scan.
    maintenanceTimer.unref?.();
  }

  // Optional outreach feedback loop: when FEEDBACK_INTERVAL_MS is a positive
  // number, periodically compare reviewed draft→final pairs and file each
  // distilled lesson as a proposal for human review. Off by default; on-demand
  // scanning is always available via `POST /api/feedback/scan`.
  const feedbackIntervalMs = Number(process.env.FEEDBACK_INTERVAL_MS);
  let feedbackTimer: NodeJS.Timeout | undefined;
  if (Number.isFinite(feedbackIntervalMs) && feedbackIntervalMs > 0) {
    feedbackTimer = setInterval(() => {
      void runFeedbackScan({ vaultIndex, proposalStore, eventBus, pathResolver }).catch(() => {
        // Best-effort: a scheduled scan must never crash the server.
      });
    }, feedbackIntervalMs);
    feedbackTimer.unref?.();
  }

  function sendJson<T>(res: http.ServerResponse, statusCode: number, body: ApiResponse<T>) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (!req.url || !req.method) {
      sendJson(res, 400, {
        success: false,
        error: { code: 'bad_request', message: 'Missing request URL or method.' },
      });
      return;
    }

    // Liveness stays credential-free (load balancers and probes cannot present
    // SVIDs), but once auth is on, remote callers no longer learn the server's
    // filesystem layout from it.
    if (req.method === 'GET' && req.url.startsWith('/health')) {
      let authEnabled = true;
      try {
        authEnabled = (await authStore.getAuth()).enabled;
      } catch {
        // Unreadable settings: keep liveness up, but redact like enabled.
      }
      const local = isLoopbackRequest(req);
      const data: HealthResponse = {
        status: 'ok',
        ...(authEnabled && !local ? {} : { contentRoot: config.contentRoot }),
        timestamp: new Date().toISOString(),
      };

      sendJson(res, 200, { success: true, data });
      return;
    }

    // The auth gate runs before every other route. With auth disabled (the
    // default) it allows everything and this server behaves exactly as it
    // always has; when enabled, it writes the 401/403 for denied requests.
    const url = new URL(req.url, 'http://internal');
    let gate;
    try {
      gate = await authGuard(req, res, url.pathname);
    } catch {
      // A real I/O fault reading auth settings must fail closed, not open.
      sendJson(res, 500, {
        success: false,
        error: { code: 'io_error', message: 'Failed to load auth settings.' },
      });
      return;
    }
    if (!gate.allowed) {
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/events')) {
      handleEventStream(req, res, eventBus);
      return;
    }

    const authResult = await handleAuthRoutes(req, res, url, {
      authStore,
      verifier: svidVerifier,
      gate,
    });
    if (authResult.handled) {
      return;
    }

    const routeResult = await handleFileRoutes(req, res, {
      repository,
      pathResolver,
      auditLog,
      proposalStore,
      questionLog,
      patchIdempotency,
      eventBus,
      vaultIndex,
    });
    if (routeResult.handled) {
      return;
    }

    sendJson(res, 404, {
      success: false,
      error: { code: 'not_found', message: 'Endpoint not found.' },
    });
  };

  // An https.Server exposes the full http.Server surface this codebase uses
  // (listen/close/address/events); the cast keeps every existing consumer —
  // the embedded MCP bootstrap included — compiling against plain HTTP.
  const server = options.tls
    ? (https.createServer(
        {
          cert: options.tls.cert,
          key: options.tls.key,
          ...(options.tls.clientCa
            ? {
                ca: options.tls.clientCa,
                // Request certs but do not require them at the TLS layer:
                // certless clients fall through to bearer (JWT-SVID) auth.
                requestCert: true,
                rejectUnauthorized: false,
              }
            : {}),
        },
        handler,
      ) as unknown as http.Server)
    : http.createServer(handler);

  // Tear down the watcher and the index (their bus subscriptions) when the
  // server closes so tests and short-lived embedded instances don't leak.
  server.on('close', () => {
    watcher.close();
    vaultIndex.close();
    if (maintenanceTimer) {
      clearInterval(maintenanceTimer);
    }
    if (feedbackTimer) {
      clearInterval(feedbackTimer);
    }
  });
  return server;
}

/**
 * Read the optional TLS environment variables:
 *   FSBRAIN_TLS_CERT / FSBRAIN_TLS_KEY   — serve HTTPS (both required together)
 *   FSBRAIN_TLS_CLIENT_CA                — additionally accept mTLS client
 *                                          certificates (X.509-SVIDs) verified
 *                                          against this CA bundle
 * Unset (the default) keeps plain HTTP — local vaults and tailnet/VPN
 * deployments that terminate TLS elsewhere need none of this.
 */
function loadTlsFromEnv(): { material: TlsMaterial; paths: string[] } | undefined {
  const certPath = process.env.FSBRAIN_TLS_CERT?.trim();
  const keyPath = process.env.FSBRAIN_TLS_KEY?.trim();
  const clientCaPath = process.env.FSBRAIN_TLS_CLIENT_CA?.trim();
  if (!certPath && !keyPath && !clientCaPath) {
    return undefined;
  }
  if (!certPath || !keyPath) {
    throw new Error('FSBRAIN_TLS_CERT and FSBRAIN_TLS_KEY must be set together.');
  }
  const material: TlsMaterial = {
    cert: readFileSync(certPath, 'utf8'),
    key: readFileSync(keyPath, 'utf8'),
    ...(clientCaPath ? { clientCa: readFileSync(clientCaPath, 'utf8') } : {}),
  };
  return { material, paths: [certPath, keyPath, ...(clientCaPath ? [clientCaPath] : [])] };
}

export function startServer(config = loadConfig()): http.Server {
  const tlsFromEnv = loadTlsFromEnv();
  const server = createServer(config, tlsFromEnv ? { tls: tlsFromEnv.material } : {});

  // SVIDs are short-lived by design (SPIRE rotates them in place), so reload
  // the secure context whenever any of the PEM files change — no restart.
  if (tlsFromEnv) {
    const reload = () => {
      try {
        const next = loadTlsFromEnv();
        if (next) {
          (server as unknown as tls.Server).setSecureContext({
            cert: next.material.cert,
            key: next.material.key,
            ...(next.material.clientCa ? { ca: next.material.clientCa } : {}),
          });
        }
      } catch {
        // Keep serving with the previous context on a partial/failed rotation.
      }
    };
    for (const pemPath of tlsFromEnv.paths) {
      // Unref so rotation-watching never keeps a closing process alive.
      watchFile(pemPath, { interval: 5000 }, reload).unref();
    }
    server.on('close', () => {
      for (const pemPath of tlsFromEnv.paths) {
        unwatchFile(pemPath, reload);
      }
    });
  }

  const scheme = tlsFromEnv ? 'https' : 'http';
  const listener = () => {
    const address = server.address();
    const bound =
      typeof address === 'object' && address ? `${address.address}:${address.port}` : config.port;
    // eslint-disable-next-line no-console
    console.log(`API server listening on ${scheme}://${bound}`);
    // eslint-disable-next-line no-console
    console.log(`CONTENT_ROOT resolved to: ${config.contentRoot}`);
  };

  if (config.host) {
    server.listen(config.port, config.host, listener);
  } else {
    server.listen(config.port, listener);
  }
  return server;
}
