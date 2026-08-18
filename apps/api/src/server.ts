import http from 'node:http';

import type { ApiResponse, HealthResponse } from '@repo/shared';

import { ensureContentRoot, loadConfig } from './config.js';
import { createEventBus } from './events/eventBus.js';
import { handleEventStream } from './events/sse.js';
import { createVaultWatcher } from './events/watcher.js';
import { createVaultIndex } from './index/vaultIndex.js';
import type { RocketReachClient, RocketReachClientOptions } from './integrations/rocketreach.js';
import {
  handleFileRoutes,
  runFeedbackScan,
  runMaintenanceScan,
  type PatchFileResponse,
} from './routes/files.js';
import { handleIntegrationRoutes } from './routes/integrations.js';
import { createAuditLog } from './storage/auditLog.js';
import { createFileRepository } from './storage/fileRepository.js';
import { createIdempotencyCache } from './storage/idempotencyCache.js';
import { createIntegrationStore } from './storage/integrationStore.js';
import { createPathResolver } from './storage/pathResolver.js';
import { createProposalStore } from './storage/proposalStore.js';
import { createQuestionLog } from './storage/questionLog.js';

export { loadConfig, ensureContentRoot, defaultContentRoot } from './config.js';
export type { ServerConfig } from './config.js';

export interface CreateServerOptions {
  /**
   * Override the RocketReach client factory. Production leaves this unset (the
   * real HTTPS client is used); tests inject a stub / a client with a fake
   * `fetch` so the suite never touches the network.
   */
  createRocketReachClient?: (options: RocketReachClientOptions) => RocketReachClient;
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
  const integrationStore = createIntegrationStore(config.contentRoot);
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

  const server = http.createServer(async (req, res) => {
    if (!req.url || !req.method) {
      sendJson(res, 400, {
        success: false,
        error: { code: 'bad_request', message: 'Missing request URL or method.' },
      });
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/health')) {
      const data: HealthResponse = {
        status: 'ok',
        contentRoot: config.contentRoot,
        timestamp: new Date().toISOString(),
      };

      sendJson(res, 200, { success: true, data });
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/events')) {
      handleEventStream(req, res, eventBus);
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

    // Optional third-party integrations (RocketReach, …). Their routes live
    // under /api/integrations and are inert unless the user enables them.
    const integrationResult = await handleIntegrationRoutes(req, res, {
      integrationStore,
      repository,
      auditLog,
      eventBus,
      createRocketReachClient: options.createRocketReachClient,
    });
    if (integrationResult.handled) {
      return;
    }

    sendJson(res, 404, {
      success: false,
      error: { code: 'not_found', message: 'Endpoint not found.' },
    });
  });

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

export function startServer(config = loadConfig()): http.Server {
  const server = createServer(config);
  const listener = () => {
    const address = server.address();
    const bound =
      typeof address === 'object' && address ? `${address.address}:${address.port}` : config.port;
    // eslint-disable-next-line no-console
    console.log(`API server listening on http://${bound}`);
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
