#!/usr/bin/env node
/**
 * Preflight check for `fsbrain-mcp`:
 *   - Node version is recent enough to run the bundled bin.
 *   - The vault directory can be created and written to.
 *
 * `CONTENT_ROOT` overrides the default. The default mirrors the API
 * (`~/.fsbrain/vault`). Exits 0 on success, 1 on any failure.
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Node 20 is end-of-life (no security patches since 2026-04-30).
const REQUIRED_MAJOR = 22;

function reportOk(label, value) {
  process.stdout.write(`ok    ${label}: ${value}\n`);
}

function reportFail(label, value) {
  process.stdout.write(`FAIL  ${label}: ${value}\n`);
}

async function checkNode() {
  const [majorStr] = process.versions.node.split('.');
  const major = Number(majorStr);
  if (!Number.isFinite(major) || major < REQUIRED_MAJOR) {
    reportFail('node version', `${process.versions.node} (need >= ${REQUIRED_MAJOR}.x)`);
    return false;
  }
  reportOk('node version', process.versions.node);
  return true;
}

async function checkVault() {
  const vault = path.resolve(
    process.env.CONTENT_ROOT ?? path.join(os.homedir(), '.fsbrain', 'vault'),
  );
  try {
    await mkdir(vault, { recursive: true });
    const probe = path.join(vault, `.doctor-${process.pid}-${Date.now()}.tmp`);
    await writeFile(probe, 'doctor');
    await rm(probe, { force: true });
  } catch (error) {
    reportFail('vault writable', `${vault} (${error.message})`);
    return false;
  }
  reportOk('vault writable', vault);
  return true;
}

const results = await Promise.all([checkNode(), checkVault()]);
process.exit(results.every(Boolean) ? 0 : 1);
