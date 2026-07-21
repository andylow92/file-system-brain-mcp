import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

const API_KEY = 'rr_secret_KEY_1234567890';

/**
 * A fake `fetch` standing in for the RocketReach API. Each test can swap the
 * behavior via `currentFetch`. The default throws, so any code path that
 * unexpectedly reaches the network fails loudly (this is how the "fail closed
 * / no network" cases are proven).
 */
let currentFetch: (url: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('RocketReach integration routes', () => {
  let contentRoot = '';
  let baseUrl = '';
  let server: http.Server | undefined;
  let fetchSpy: ReturnType<typeof vi.fn>;

  async function api<T>(
    method: string,
    pathname: string,
    options: { body?: unknown } = {},
  ): Promise<{ status: number; body: ApiResponse<T> }> {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: (await response.json()) as ApiResponse<T> };
  }

  const enableWithKey = () =>
    api('PUT', '/api/integrations/rocketreach', { body: { enabled: true, apiKey: API_KEY } });

  beforeEach(async () => {
    contentRoot = await mkdtemp(path.join(os.tmpdir(), 'integrations-root-'));
    process.env.CONTENT_ROOT = contentRoot;
    vi.resetModules();

    // Default: reaching the network is a bug — throw so it surfaces in a test.
    currentFetch = () => {
      throw new Error('unexpected network call');
    };
    fetchSpy = vi.fn((url: string, init?: RequestInit) => currentFetch(url, init));

    // Import the client factory and the server from the SAME fresh module graph
    // (post-resetModules) so the RocketReachError the client throws is the exact
    // class the routes check with `instanceof`.
    const { createRocketReachClient } = await import('../integrations/rocketreach.js');
    const { createServer } = await import('../server.js');
    server = createServer(undefined, {
      // Real client wired to the fake fetch — exercises the true mapping +
      // redaction logic without touching the network.
      createRocketReachClient: (opts) =>
        createRocketReachClient({
          ...opts,
          baseUrl: 'https://rocketreach.test/v2',
          fetchImpl: fetchSpy as unknown as typeof fetch,
        }),
    });
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
    delete process.env.CONTENT_ROOT;
  });

  it('is disabled by default', async () => {
    const res = await api<{ enabled: boolean; configured: boolean; state: string }>(
      'GET',
      '/api/integrations/rocketreach',
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ enabled: false, configured: false, state: 'disabled' });
  });

  it('exposes the intake questions (including a required lookup budget)', async () => {
    const res = await api<{ questions: Array<{ id: string; required: boolean }> }>(
      'GET',
      '/api/integrations/rocketreach/intake',
    );
    expect(res.status).toBe(200);
    const questions = res.body.data!.questions;
    expect(questions.length).toBeGreaterThan(0);
    const maxLookups = questions.find((q) => q.id === 'maxLookups');
    expect(maxLookups?.required).toBe(true);
  });

  it('fails closed while disabled — no network call is made', async () => {
    const test = await api('POST', '/api/integrations/rocketreach/test');
    expect(test.status).toBe(409);
    expect(test.body.error?.code).toBe('integration_disabled');

    const search = await api('POST', '/api/integrations/rocketreach/search', {
      body: { titles: ['CTO'] },
    });
    expect(search.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('enabling without a key returns setup-required for API calls', async () => {
    const put = await api<{ state: string }>('PUT', '/api/integrations/rocketreach', {
      body: { enabled: true },
    });
    expect(put.body.data).toMatchObject({
      enabled: true,
      configured: false,
      state: 'enabled_unconfigured',
    });

    const test = await api('POST', '/api/integrations/rocketreach/test');
    expect(test.status).toBe(409);
    expect(test.body.error?.code).toBe('setup_required');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stores a key without ever echoing it back (masked hint only)', async () => {
    const put = await enableWithKey();
    expect(put.body.data).toMatchObject({ enabled: true, configured: true, state: 'enabled' });
    // The raw key must never appear in a response.
    expect(JSON.stringify(put.body)).not.toContain(API_KEY);
    expect((put.body.data as { keyHint?: string }).keyHint).toBeTruthy();
    expect((put.body.data as { keyHint?: string }).keyHint).not.toBe(API_KEY);
    expect((put.body.data as { apiKey?: string }).apiKey).toBeUndefined();
  });

  it('reports account status and credits with a valid key', async () => {
    await enableWithKey();
    currentFetch = async (url) => {
      expect(url).toContain('/account/');
      return jsonResponse(200, { name: 'Ada', plan: 'pro', lookup_credit_balance: 42 });
    };
    const res = await api<{ connected: boolean; account: { lookupCreditBalance: number } }>(
      'POST',
      '/api/integrations/rocketreach/test',
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ connected: true, account: { lookupCreditBalance: 42 } });
  });

  it('surfaces an invalid key as 401 without leaking the key', async () => {
    await enableWithKey();
    currentFetch = async () => jsonResponse(401, { message: 'unauthorized' });
    const res = await api('POST', '/api/integrations/rocketreach/test');
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('invalid_key');
    expect(JSON.stringify(res.body)).not.toContain(API_KEY);
  });

  it('redacts the API key from a provider error message', async () => {
    await enableWithKey();
    // A hostile/echoing provider error that includes the key verbatim.
    currentFetch = async () => jsonResponse(400, { message: `bad request for key ${API_KEY}` });
    const res = await api('POST', '/api/integrations/rocketreach/test');
    expect(res.body.error).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain(API_KEY);
    expect(res.body.error?.message).toContain('redacted');
  });

  it('search returns mapped candidates and spends no lookup credits', async () => {
    await enableWithKey();
    currentFetch = async (url, init) => {
      expect(url).toContain('/api/search');
      expect(init?.method).toBe('POST');
      return jsonResponse(200, {
        profiles: [
          {
            id: 'p1',
            name: 'Ada Lovelace',
            current_title: 'CTO',
            current_employer: 'Analytical Engines',
            location: 'London, UK',
            linkedin_url: 'https://linkedin.com/in/ada',
          },
        ],
      });
    };
    const res = await api<{ candidates: Array<{ name: string; title?: string }>; count: number }>(
      'POST',
      '/api/integrations/rocketreach/search',
      { body: { titles: ['CTO'], maxCandidates: 10 } },
    );
    expect(res.status).toBe(200);
    expect(res.body.data!.count).toBe(1);
    expect(res.body.data!.candidates[0]).toMatchObject({ name: 'Ada Lovelace', title: 'CTO' });
  });

  it('lookup requires an explicit positive limit', async () => {
    await enableWithKey();
    const res = await api('POST', '/api/integrations/rocketreach/lookup', {
      body: { ids: ['p1'] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('lookup_limit_required');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lookup never enriches more than the cap — the overflow is skipped, not spent', async () => {
    await enableWithKey();
    const lookedUp: string[] = [];
    currentFetch = async (url) => {
      if (url.includes('/account/')) {
        return jsonResponse(200, { lookup_credit_balance: 5 });
      }
      const id = new URL(url).searchParams.get('id') ?? '';
      lookedUp.push(id);
      return jsonResponse(200, {
        id,
        name: `Person ${id}`,
        emails: [{ email: `${id}@work.com` }],
      });
    };
    const res = await api<{
      contacts: Array<{ id: string; emails?: string[] }>;
      skipped: Array<{ id: string; reason: string }>;
    }>('POST', '/api/integrations/rocketreach/lookup', {
      body: { ids: ['p1', 'p2', 'p3'], maxLookups: 1 },
    });
    expect(res.status).toBe(200);
    // Only ONE paid lookup happened, regardless of how many ids were passed.
    expect(lookedUp).toEqual(['p1']);
    expect(res.body.data!.contacts).toHaveLength(1);
    expect(res.body.data!.skipped.map((s) => s.id)).toEqual(['p2', 'p3']);
    expect(res.body.data!.contacts[0].emails).toEqual(['p1@work.com']);
  });

  it('can save a run into the vault with provenance', async () => {
    await enableWithKey();
    currentFetch = async () =>
      jsonResponse(200, {
        profiles: [{ id: 'p1', name: 'Ada Lovelace', current_title: 'CTO' }],
      });
    const res = await api<{ savedTo?: string }>('POST', '/api/integrations/rocketreach/search', {
      body: {
        audience: 'growth leaders',
        titles: ['CTO'],
        save: 'fsbrain',
        project: 'Q3 outreach',
      },
    });
    const savedTo = res.body.data!.savedTo;
    expect(savedTo).toMatch(/^prospects\/.+\.md$/);

    const note = await api<{ content: string }>(
      'GET',
      `/api/file?path=${encodeURIComponent(savedTo!)}`,
    );
    expect(note.status).toBe(200);
    expect(note.body.data!.content).toContain('type: prospect-run');
    expect(note.body.data!.content).toContain('Ada Lovelace');
  });

  it('disabling after enablement makes subsequent calls fail closed', async () => {
    await enableWithKey();
    await api('PUT', '/api/integrations/rocketreach', { body: { enabled: false } });
    const test = await api('POST', '/api/integrations/rocketreach/test');
    expect(test.status).toBe(409);
    expect(test.body.error?.code).toBe('integration_disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('removing the key clears configured state', async () => {
    await enableWithKey();
    const removed = await api<{ configured: boolean; state: string }>(
      'PUT',
      '/api/integrations/rocketreach',
      { body: { apiKey: null } },
    );
    expect(removed.body.data).toMatchObject({ configured: false, state: 'enabled_unconfigured' });
  });
});
