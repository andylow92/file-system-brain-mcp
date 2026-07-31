#!/usr/bin/env node
/**
 * Cerebro single-port launcher.
 *
 * The web UI calls the API with relative `/api/...` paths (including the
 * `/api/events` SSE stream), so the browser app and the API must share one
 * origin. The bare API server (apps/api) only answers `/api` and serves no
 * static files. This launcher bridges that with zero npm dependencies:
 *
 *   1. spawns the API server as a child on an internal port (default 3001),
 *      pointed at the vault via CONTENT_ROOT;
 *   2. serves the built web UI (apps/web/dist) and reverse-proxies `/api`
 *      (SSE included) on the public port (default 2800).
 *
 * Run by the LaunchAgent org.eigenoid.cerebro at login. If the API child dies
 * the launcher exits so launchd (KeepAlive) restarts the whole stack cleanly.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = join(REPO, 'apps', 'web', 'dist');
// The API imports @repo/shared, whose package "main" points at TS source, so
// `node dist/main.js` can't resolve it. Run it through tsx (the project's own
// dev runner) against src instead.
const TSX_CLI = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const API_ENTRY = join(REPO, 'apps', 'api', 'src', 'main.ts');

const PUBLIC_PORT = Number(process.env.CEREBRO_PORT ?? 2800);
const API_PORT = Number(process.env.CEREBRO_API_PORT ?? 3001);
const API_HOST = '127.0.0.1';
const CONTENT_ROOT =
  process.env.CONTENT_ROOT ??
  join(REPO, '..', 'memory'); // -> eigenoid-org/cerebro/memory

// --- spawn the API server as a child ---------------------------------------
const api = spawn(process.execPath, [TSX_CLI, API_ENTRY], {
  cwd: REPO,
  env: { ...process.env, PORT: String(API_PORT), HOST: API_HOST, CONTENT_ROOT },
  stdio: 'inherit',
});
api.on('exit', (code) => {
  console.error(`[cerebro] API exited (code ${code}); exiting so launchd restarts the stack.`);
  process.exit(1);
});
const shutdown = (sig) => {
  api.kill(sig);
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- static file serving (with SPA fallback) -------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  if (rel === '/' || rel === '') rel = '/index.html';
  let filePath = join(WEB_DIST, rel);
  // Containment guard against path traversal.
  if (!filePath.startsWith(WEB_DIST)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  // SPA fallback: unknown client-side routes resolve to index.html.
  let servedFallback = false;
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = join(WEB_DIST, 'index.html');
    servedFallback = true;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Web UI not built. Run `npm run build` in apps/web.');
    return;
  }
  // Vite fingerprints everything under /assets, so real ones are safe to cache
  // forever. index.html must never be cached: a stale copy points at a bundle
  // hash that no longer exists, and the fallback above would answer that .js
  // request with HTML — a confusing break after every deploy. Only mark it
  // immutable when the hashed file actually resolved, never for a fallback.
  const isHashedAsset = rel.startsWith('/assets/') && !servedFallback;
  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
    'Cache-Control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(filePath).pipe(res);
}

// --- reverse-proxy /api -> API server (streams SSE unbuffered) -------------
function proxyApi(req, res) {
  const proxyReq = http.request(
    { host: API_HOST, port: API_PORT, method: req.method, path: req.url, headers: req.headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', (err) => {
    // An in-flight SSE stream (/api/events) has already sent its headers, so
    // writeHead would throw ERR_HTTP_HEADERS_SENT and take the launcher down
    // with it. Once streaming has begun the only correct move is to drop the
    // socket and let the browser reconnect.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Bad gateway (API not ready?): ${err.message}`);
  });
  // If the client hangs up mid-stream, stop proxying rather than writing to a
  // dead socket.
  res.on('close', () => proxyReq.destroy());
  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  if ((req.url || '').startsWith('/api')) proxyApi(req, res);
  else serveStatic(req, res);
});

server.listen(PUBLIC_PORT, '127.0.0.1', () => {
  console.log(
    `[cerebro] http://localhost:${PUBLIC_PORT}  (api -> :${API_PORT}, CONTENT_ROOT=${CONTENT_ROOT})`,
  );
});
