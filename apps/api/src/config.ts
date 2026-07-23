import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ServerConfig {
  port: number;
  /** Optional bind address; defaults to Node's default (all interfaces). */
  host?: string;
  contentRoot: string;
}

/**
 * A vault path that works without configuration: under the user's home
 * directory so a fresh `npm run dev:api` (or an OpenClaw-launched MCP entry
 * with no `CONTENT_ROOT` set) lands in a stable, predictable location.
 */
export function defaultContentRoot(): string {
  return path.join(os.homedir(), '.fsbrain', 'vault');
}

export function loadConfig(): ServerConfig {
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST?.trim() || undefined;
  const contentRoot = path.resolve(process.env.CONTENT_ROOT ?? defaultContentRoot());

  return {
    port,
    host,
    contentRoot,
  };
}

/** Internal-state directory inside the vault (audit log, integration settings, …). */
const INTERNAL_DIR = '.fsbrain';

/** Make sure `CONTENT_ROOT` exists before any storage code touches it. */
export function ensureContentRoot(contentRoot: string): void {
  mkdirSync(contentRoot, { recursive: true });
  // `.fsbrain/` holds secrets (integrations.json carries API keys), and the
  // product encourages version-controlling the vault — seed a catch-all
  // .gitignore so `git add -A` on the vault can never commit them. An existing
  // file is left alone in case the user customized it.
  const internalDir = path.join(contentRoot, INTERNAL_DIR);
  mkdirSync(internalDir, { recursive: true });
  const gitignorePath = path.join(internalDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, '*\n', 'utf8');
  }
}
