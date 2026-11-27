import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultEvent } from '@repo/shared';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/**
 * Open the SSE stream and collect VaultEvents. Exposes `waitFor` (resolves when
 * a matching event arrives, with a timeout so tests can't hang) and `seen` (a
 * snapshot of events received so far, for negative assertions).
 */
function openEventStream(baseUrl: string) {
  const events: VaultEvent[] = [];
  const waiters: Array<{ predicate: (e: VaultEvent) => boolean; settle: (e: VaultEvent) => void }> =
    [];
  let buffer = '';

  const req = http.get(`${baseUrl}/api/events`);
  const ready = new Promise<void>((resolve) => {
    req.on('response', (res) => {
      res.setEncoding('utf8');
      resolve();
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) {
              continue;
            }
            try {
              const event = JSON.parse(line.slice(5).trim()) as VaultEvent;
              events.push(event);
              for (let i = waiters.length - 1; i >= 0; i -= 1) {
                if (waiters[i].predicate(event)) {
                  waiters[i].settle(event);
                  waiters.splice(i, 1);
                }
              }
            } catch {
              // ignore non-JSON frames (heartbeats / comments)
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      });
    });
  });

  function waitFor(predicate: (e: VaultEvent) => boolean, timeoutMs = 3000): Promise<VaultEvent> {
    const existing = events.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise<VaultEvent>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for vault event')),
        timeoutMs,
      );
      waiters.push({
        predicate,
        settle: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
      });
    });
  }

  return {
    ready,
    waitFor,
    seen: () => [...events],
    close: () => req.destroy(),
  };
}

describe('live vault events (SSE + file watcher)', () => {
  let contentRoot = '';
  let baseUrl = '';
  let server: http.Server | undefined;

  async function api<T>(
    method: string,
    pathname: string,
    options: { body?: unknown; actor?: string } = {},
  ): Promise<{ status: number; body: ApiResponse<T> }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.actor) {
      headers['X-Actor'] = options.actor;
    }
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: (await response.json()) as ApiResponse<T> };
  }

  beforeEach(async () => {
    contentRoot = await mkdtemp(path.join(os.tmpdir(), 'events-root-'));
    process.env.CONTENT_ROOT = contentRoot;
    vi.resetModules();

    const { createServer } = await import('../server.js');
    server = createServer();
    await new Promise<void>((resolve) => server!.listen(0, () => resolve()));

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to determine server address');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
    await rm(contentRoot, { recursive: true, force: true });
  });

  it('streams an api-sourced event when a file is created, updated, and deleted', async () => {
    const stream = openEventStream(baseUrl);
    await stream.ready;

    const created = await api('POST', '/api/file', {
      body: { path: 'live.md', content: '# Live' },
      actor: 'agent:test',
    });
    expect(created.status).toBe(201);

    const createdEvent = await stream.waitFor((e) => e.type === 'created' && e.path === 'live.md');
    expect(createdEvent).toMatchObject({ source: 'api', actor: 'agent:test', path: 'live.md' });

    await api('PUT', '/api/file', { body: { path: 'live.md', content: '# Live v2' } });
    const updatedEvent = await stream.waitFor((e) => e.type === 'updated' && e.path === 'live.md');
    expect(updatedEvent).toMatchObject({ source: 'api' });

    await api('DELETE', '/api/path?path=live.md');
    const deletedEvent = await stream.waitFor((e) => e.type === 'deleted' && e.path === 'live.md');
    expect(deletedEvent.source).toBe('api');

    stream.close();
  });

  it('does not double-fire a watch event for an api-originated write', async () => {
    const stream = openEventStream(baseUrl);
    await stream.ready;

    await api('POST', '/api/file', { body: { path: 'once.md', content: 'hi' } });
    await stream.waitFor((e) => e.type === 'created' && e.path === 'once.md');

    // Give the watcher's debounce + dedupe window time to (not) fire.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const watchDupes = stream.seen().filter((e) => e.path === 'once.md' && e.source === 'watch');
    expect(watchDupes).toHaveLength(0);

    stream.close();
  });

  it('emits a source:"watch" event for a direct fs write under CONTENT_ROOT', async () => {
    const stream = openEventStream(baseUrl);
    await stream.ready;

    await writeFile(path.join(contentRoot, 'external.md'), '# Edited outside the API', 'utf8');

    const watchEvent = await stream.waitFor(
      (e) => e.source === 'watch' && e.path === 'external.md',
    );
    expect(watchEvent.type).toBe('created');

    stream.close();
  });

  it('does NOT emit events for writes inside the hidden .fsbrain/ dir', async () => {
    const stream = openEventStream(baseUrl);
    await stream.ready;

    await mkdir(path.join(contentRoot, '.fsbrain'), { recursive: true });
    await writeFile(path.join(contentRoot, '.fsbrain', 'secret.md'), 'internal', 'utf8');
    // A normal write that we DO expect, used as a fence: once it arrives, the
    // watcher has processed the batch and the hidden write must not be present.
    await writeFile(path.join(contentRoot, 'visible.md'), '# Visible', 'utf8');

    await stream.waitFor((e) => e.source === 'watch' && e.path === 'visible.md');

    const hidden = stream.seen().filter((e) => e.path.includes('.fsbrain'));
    expect(hidden).toHaveLength(0);

    stream.close();
  });

  it('emits watch events for out-of-band html create / update / delete', async () => {
    const stream = openEventStream(baseUrl);
    await stream.ready;
    const reportPath = path.join(contentRoot, 'report.html');

    await writeFile(reportPath, '<h1>v1</h1>', 'utf8');
    const created = await stream.waitFor((e) => e.source === 'watch' && e.path === 'report.html');
    expect(created).toMatchObject({ type: 'created', actor: 'external' });

    await writeFile(reportPath, '<h1>v2</h1>', 'utf8');
    await stream.waitFor(
      (e) => e.source === 'watch' && e.path === 'report.html' && e.type === 'updated',
    );

    await unlink(reportPath);
    await stream.waitFor(
      (e) => e.source === 'watch' && e.path === 'report.html' && e.type === 'deleted',
    );

    stream.close();
  });

  it('still ignores other extensions and hidden html', async () => {
    const stream = openEventStream(baseUrl);
    await stream.ready;

    await writeFile(path.join(contentRoot, 'notes.txt'), 'plain', 'utf8');
    await mkdir(path.join(contentRoot, '.hidden'), { recursive: true });
    await writeFile(path.join(contentRoot, '.hidden', 'x.html'), '<p>hidden</p>', 'utf8');
    await writeFile(path.join(contentRoot, '.dot.html'), '<p>dotfile</p>', 'utf8');
    // Fence: once this arrives, the watcher has flushed the batch above.
    await writeFile(path.join(contentRoot, 'fence.htm'), '<p>fence</p>', 'utf8');

    await stream.waitFor((e) => e.source === 'watch' && e.path === 'fence.htm');

    expect(stream.seen().filter((e) => e.path !== 'fence.htm')).toEqual([]);

    stream.close();
  });
});
