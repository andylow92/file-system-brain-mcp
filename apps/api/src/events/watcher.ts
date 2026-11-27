import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';

import { documentFormatForPath, type VaultEvent } from '@repo/shared';

import type { EventBus } from './eventBus.js';

/**
 * Watches CONTENT_ROOT recursively and publishes `source: 'watch'` VaultEvents
 * for changes that did NOT go through the API — a direct file edit, a `git`
 * operation, another process. API-originated writes also touch the filesystem,
 * so to avoid double-firing we de-dupe: the watcher tracks paths the API just
 * reported (by subscribing to the same bus) and skips a watch event for a path
 * the API emitted within a short window.
 *
 * Conventions preserved: the hidden `.fsbrain/` dir (and any dotfile/dir) is
 * ignored, and only supported documents — `.md` notes and read-only `.html` /
 * `.htm` documents (`documentFormatForPath`) — emit events, matching what the
 * tree surfaces. Every other extension stays ignored.
 */
export interface VaultWatcher {
  close(): void;
}

const DEFAULT_DEBOUNCE_MS = 150;
/**
 * How long an API-originated change "claims" a path so the watcher won't also
 * fire for it. Must comfortably exceed the debounce so the watch flush (which
 * runs `debounceMs` after the fs event) still sees the API's claim.
 */
const DEDUPE_WINDOW_MS = 1000;

function isIgnoredRelativePath(relativePath: string): boolean {
  if (!relativePath) {
    return true;
  }
  // Ignore anything inside a hidden segment (e.g. `.fsbrain/…`) or a dotfile.
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment.startsWith('.'))) {
    return true;
  }
  // Only supported documents (markdown + read-only HTML) participate in the live layer.
  return documentFormatForPath(relativePath) === null;
}

/** Recursively collect the logical paths of every supported document under a root. */
async function scanDocumentPaths(root: string): Promise<Set<string>> {
  const found = new Set<string>();

  async function walk(dir: string, prefix: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relativePath);
      } else if (entry.isFile() && documentFormatForPath(entry.name)) {
        found.add(relativePath);
      }
    }
  }

  await walk(root, '');
  return found;
}

export function createVaultWatcher(options: {
  contentRoot: string;
  eventBus: EventBus;
  debounceMs?: number;
}): VaultWatcher {
  const { contentRoot, eventBus } = options;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  // Logical paths the API recently reported, with the time it claimed them.
  const recentApiPaths = new Map<string, number>();
  // Known document paths, so we can distinguish created / updated / deleted.
  const knownPaths = new Set<string>();
  // Pending (debounced) paths awaiting a flush.
  const pending = new Set<string>();
  let flushTimer: NodeJS.Timeout | undefined;

  function claim(relativePath: string): void {
    recentApiPaths.set(relativePath, Date.now());
  }

  /** Drop de-dupe claims older than the window so the map can't grow unbounded. */
  function pruneClaims(now: number): void {
    for (const [claimedPath, at] of recentApiPaths) {
      if (now - at >= DEDUPE_WINDOW_MS) {
        recentApiPaths.delete(claimedPath);
      }
    }
  }

  function recentlyClaimedByApi(relativePath: string): boolean {
    const at = recentApiPaths.get(relativePath);
    if (at === undefined) {
      return false;
    }
    return Date.now() - at < DEDUPE_WINDOW_MS;
  }

  // Keep the known-paths set and the de-dupe claims in sync with API events so
  // a later out-of-band edit to an API-created file reports `updated`, not a
  // spurious `created`.
  const unsubscribe = eventBus.subscribe((event: VaultEvent) => {
    if (event.source !== 'api') {
      return;
    }
    if (event.path) {
      claim(event.path);
    }
    if (event.toPath) {
      claim(event.toPath);
    }
    switch (event.type) {
      case 'created':
      case 'updated':
        knownPaths.add(event.path);
        break;
      case 'deleted':
        knownPaths.delete(event.path);
        break;
      case 'moved':
        knownPaths.delete(event.path);
        if (event.toPath) {
          knownPaths.add(event.toPath);
        }
        break;
      default:
        break;
    }
  });

  // The watcher starts handling fs events immediately, but classifying
  // created-vs-updated correctly needs the initial scan's known-paths set.
  // `flush` defers until this resolves so an edit landing in the startup window
  // isn't mislabeled `created`.
  let scanComplete = false;
  void scanDocumentPaths(contentRoot).then((paths) => {
    // Merge rather than replace: API events may have arrived during the scan.
    for (const p of paths) {
      knownPaths.add(p);
    }
    scanComplete = true;
  });

  function flush(): void {
    flushTimer = undefined;
    if (!scanComplete) {
      // Wait for the initial scan (always resolves) before classifying.
      flushTimer = setTimeout(flush, debounceMs);
      flushTimer.unref?.();
      return;
    }

    const now = Date.now();
    pruneClaims(now);
    const paths = [...pending];
    pending.clear();

    for (const relativePath of paths) {
      if (recentlyClaimedByApi(relativePath)) {
        continue;
      }

      const existsNow = fs.existsSync(path.join(contentRoot, relativePath));
      const known = knownPaths.has(relativePath);

      let type: VaultEvent['type'] | undefined;
      if (existsNow && !known) {
        type = 'created';
        knownPaths.add(relativePath);
      } else if (existsNow && known) {
        type = 'updated';
      } else if (!existsNow && known) {
        type = 'deleted';
        knownPaths.delete(relativePath);
      }

      if (!type) {
        continue; // spurious event for a path we never tracked
      }

      eventBus.publish({
        type,
        path: relativePath,
        actor: 'external',
        ts: new Date().toISOString(),
        source: 'watch',
      });
    }
  }

  function schedule(relativePath: string): void {
    pending.add(relativePath);
    if (flushTimer) {
      clearTimeout(flushTimer);
    }
    flushTimer = setTimeout(flush, debounceMs);
    flushTimer.unref?.();
  }

  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(contentRoot, { recursive: true }, (_eventType, filename) => {
      if (!filename) {
        return;
      }
      const relativePath = filename.toString().split(path.sep).join('/');
      if (isIgnoredRelativePath(relativePath)) {
        return;
      }
      schedule(relativePath);
    });
    // The watcher shouldn't keep the process (or test runner) alive on its own.
    watcher.unref?.();
    // A watch error (e.g. the root was removed) must not crash the server.
    watcher.on('error', () => {});
  } catch {
    // Recursive fs.watch is unsupported on this platform; the live layer
    // degrades to API-only events rather than failing to start.
    watcher = undefined;
  }

  return {
    close(): void {
      unsubscribe();
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      watcher?.close();
      watcher = undefined;
    },
  };
}
