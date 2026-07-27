import { promises as fs, readFileSync, watchFile } from 'node:fs';

import { Agent, setGlobalDispatcher } from 'undici';

/**
 * Outbound credentials for proxied mode (`API_BASE_URL` set), used when the
 * remote vault has its optional SPIFFE auth enabled. All of it is opt-in via
 * environment variables; with none set, requests go out exactly as before.
 *
 * Bearer identity (JWT-SVID) — pick one:
 *   FSBRAIN_API_TOKEN         a token pasted directly into the environment
 *   FSBRAIN_API_TOKEN_FILE    path to a token file that a SPIFFE helper
 *                             (spiffe-helper, spire-agent api fetch jwt, a
 *                             cron) rotates in place; re-read when its mtime
 *                             changes, so rotation needs no restart
 *
 * Transport identity/trust (X.509-SVID mTLS and/or a private server CA):
 *   FSBRAIN_CLIENT_TLS_CERT   client certificate PEM path (with _KEY)
 *   FSBRAIN_CLIENT_TLS_KEY    client private key PEM path
 *   FSBRAIN_CLIENT_TLS_CA     CA bundle PEM path used to verify the server
 *                             (for vaults serving TLS from a private CA)
 */

let tokenCache: { path: string; mtimeMs: number; header: string } | undefined;

/** Resolve the `Authorization` header value, or `undefined` when unconfigured. */
export async function resolveAuthHeader(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const staticToken = env.FSBRAIN_API_TOKEN?.trim();
  if (staticToken) {
    return `Bearer ${staticToken}`;
  }
  const tokenFile = env.FSBRAIN_API_TOKEN_FILE?.trim();
  if (!tokenFile) {
    return undefined;
  }
  let stat;
  try {
    stat = await fs.stat(tokenFile);
  } catch {
    throw new Error(`FSBRAIN_API_TOKEN_FILE is set but unreadable: ${tokenFile}`);
  }
  if (tokenCache && tokenCache.path === tokenFile && tokenCache.mtimeMs === stat.mtimeMs) {
    return tokenCache.header;
  }
  const raw = (await fs.readFile(tokenFile, 'utf8')).trim();
  if (!raw) {
    throw new Error(`FSBRAIN_API_TOKEN_FILE is empty: ${tokenFile}`);
  }
  const header = `Bearer ${raw}`;
  tokenCache = { path: tokenFile, mtimeMs: stat.mtimeMs, header };
  return header;
}

/** Test hook: drop the token-file cache so a fresh read is forced. */
export function resetAuthHeaderCache(): void {
  tokenCache = undefined;
}

interface ClientTlsPaths {
  cert?: string;
  key?: string;
  ca?: string;
}

function tlsPathsFromEnv(env: NodeJS.ProcessEnv): ClientTlsPaths | undefined {
  const cert = env.FSBRAIN_CLIENT_TLS_CERT?.trim();
  const key = env.FSBRAIN_CLIENT_TLS_KEY?.trim();
  const ca = env.FSBRAIN_CLIENT_TLS_CA?.trim();
  if (!cert && !key && !ca) {
    return undefined;
  }
  if (Boolean(cert) !== Boolean(key)) {
    throw new Error('FSBRAIN_CLIENT_TLS_CERT and FSBRAIN_CLIENT_TLS_KEY must be set together.');
  }
  return {
    ...(cert ? { cert } : {}),
    ...(key ? { key } : {}),
    ...(ca ? { ca } : {}),
  };
}

/** Read the PEM material for the undici Agent. Exported for tests. */
export function resolveClientTlsConnect(
  env: NodeJS.ProcessEnv = process.env,
): { cert?: string; key?: string; ca?: string } | undefined {
  const paths = tlsPathsFromEnv(env);
  if (!paths) {
    return undefined;
  }
  return {
    ...(paths.cert ? { cert: readFileSync(paths.cert, 'utf8') } : {}),
    ...(paths.key ? { key: readFileSync(paths.key, 'utf8') } : {}),
    ...(paths.ca ? { ca: readFileSync(paths.ca, 'utf8') } : {}),
  };
}

/**
 * Install a global undici dispatcher carrying the client TLS identity, and
 * keep it fresh: X.509-SVIDs rotate in place, so any PEM change rebuilds the
 * agent. No-op when no TLS variables are set. This process only talks to the
 * vault API, so a process-wide dispatcher is the simplest correct scope.
 */
export function configureClientTls(env: NodeJS.ProcessEnv = process.env): void {
  const paths = tlsPathsFromEnv(env);
  if (!paths) {
    return;
  }

  const apply = () => {
    const connect = resolveClientTlsConnect(env);
    if (connect) {
      setGlobalDispatcher(new Agent({ connect }));
    }
  };
  apply();

  const watched = [paths.cert, paths.key, paths.ca].filter((p): p is string => Boolean(p));
  const reload = () => {
    try {
      apply();
    } catch {
      // A partial rotation (key updated before cert) resolves on the next tick;
      // keep the previous identity in the meantime.
    }
  };
  for (const pemPath of watched) {
    // Unref so watching certs never keeps a finished stdio session alive.
    watchFile(pemPath, { interval: 5000 }, reload).unref();
  }
}
