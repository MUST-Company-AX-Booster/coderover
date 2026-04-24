/**
 * Focused tests for the cache-fallback behavior added in the catalog
 * caching change. Existing coverage for the happy path (initialize /
 * tools/list / tools/call) lives in test/server.*.spec.ts — those
 * tests exercise the full McpServer ↔ RemoteTransport ↔ HttpClient
 * stack and don't need updating.
 *
 * Here we verify the *disk cache* fallback in isolation:
 *
 *   1. Successful fetch writes to cache.
 *   2. Failing fetch reads from cache and emits a warning log line.
 *   3. Failing fetch with no cache re-throws the original BackendError.
 *   4. CapabilityMismatchError skips cache fallback (hard gate).
 *   5. Constructor rejects `cache` without `apiUrl`.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  RemoteTransport,
  BackendError,
  CapabilityMismatchError,
} from '../../src/transport/remote-transport';
import type {
  HttpClient,
  HttpResponse,
} from '../../src/transport/http-client';
import { CapabilitiesCache } from '../../src/transport/capabilities-cache';
import type { BackendCapabilities } from '../../src/protocol';

async function mkHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'coderover-rt-'));
}

const API = 'https://api.example.com';

const CAPS: BackendCapabilities = {
  version: '0.9.1',
  tools: ['search_code', 'find_symbol', 'find_dependencies', 'get_file'],
  features: { confidence_tags: true, incremental_cache: false },
};

function okJsonResponse(body: unknown): HttpResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function errorResponse(status: number): HttpResponse {
  return {
    ok: false,
    status,
    statusText: 'Service Unavailable',
    text: async () => '',
    json: async () => ({}),
  };
}

/** HttpClient whose request() delegates to a per-test handler. */
function httpWith(
  handler: (method: 'GET' | 'POST', p: string) => Promise<HttpResponse>,
): HttpClient {
  return {
    request: (method, p) => handler(method, p),
  };
}

describe('RemoteTransport — catalog cache', () => {
  it('writes capabilities to the disk cache on a successful fetch', async () => {
    const home = await mkHome();
    const cache = new CapabilitiesCache({ homeDir: home });
    let called = false;
    const http = httpWith(async () => {
      called = true;
      return okJsonResponse(CAPS);
    });
    const t = new RemoteTransport({ http, cache, apiUrl: API });
    const caps = await t.getCapabilities();
    expect(caps.version).toBe('0.9.1');
    expect(called).toBe(true);
    const stored = cache.read(API);
    expect(stored?.capabilities.version).toBe('0.9.1');
  });

  it('falls back to cache on a non-ok HTTP response and logs a warning', async () => {
    const home = await mkHome();
    const cache = new CapabilitiesCache({ homeDir: home });
    cache.write(API, { capabilities: CAPS });
    const logs: string[] = [];
    const http = httpWith(async () => errorResponse(503));
    const t = new RemoteTransport({
      http,
      cache,
      apiUrl: API,
      log: (msg) => logs.push(msg),
    });
    const caps = await t.getCapabilities();
    expect(caps.version).toBe('0.9.1');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toMatch(/Backend unreachable/);
    expect(logs[0]).toMatch(/cached capabilities/);
  });

  it('falls back to cache on transport-level failure (fetch rejects)', async () => {
    const home = await mkHome();
    const cache = new CapabilitiesCache({ homeDir: home });
    cache.write(API, { capabilities: CAPS });
    const http = httpWith(async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:443');
    });
    const t = new RemoteTransport({ http, cache, apiUrl: API });
    const caps = await t.getCapabilities();
    expect(caps.version).toBe('0.9.1');
  });

  it('re-throws BackendError when there is no cached entry', async () => {
    const home = await mkHome();
    const cache = new CapabilitiesCache({ homeDir: home });
    const http = httpWith(async () => errorResponse(502));
    const t = new RemoteTransport({ http, cache, apiUrl: API });
    await expect(t.getCapabilities()).rejects.toBeInstanceOf(BackendError);
  });

  it('does not fall back on CapabilityMismatchError — hard version gate stays hard', async () => {
    const home = await mkHome();
    const cache = new CapabilitiesCache({ homeDir: home });
    // Seed a valid cache, then force the live backend to report a
    // too-old version. We want the mismatch to throw regardless of
    // what's cached; otherwise a blip during upgrade could silently
    // pin a client to a pre-minimum backend.
    cache.write(API, { capabilities: CAPS });
    const tooOld: BackendCapabilities = {
      ...CAPS,
      version: '0.0.1',
    };
    const http = httpWith(async () => okJsonResponse(tooOld));
    const t = new RemoteTransport({ http, cache, apiUrl: API });
    await expect(t.getCapabilities()).rejects.toBeInstanceOf(
      CapabilityMismatchError,
    );
  });

  it('rejects cache without apiUrl (misconfiguration guard)', () => {
    const cache = new CapabilitiesCache({ homeDir: os.tmpdir() });
    const http = httpWith(async () => okJsonResponse(CAPS));
    expect(() => new RemoteTransport({ http, cache })).toThrow(
      /requires `apiUrl`/,
    );
  });

  it('tools/list falls back to cached tools on failure', async () => {
    const home = await mkHome();
    const cache = new CapabilitiesCache({ homeDir: home });
    const cachedTools = [
      {
        name: 'search_code',
        description: 'cached',
        inputSchema: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      },
    ];
    cache.write(API, { capabilities: CAPS, tools: cachedTools });
    const http = httpWith(async () => {
      throw new Error('network down');
    });
    const logs: string[] = [];
    const t = new RemoteTransport({
      http,
      cache,
      apiUrl: API,
      log: (msg) => logs.push(msg),
    });
    const tools = await t.listTools();
    expect(tools).toEqual(cachedTools);
    expect(logs.some((l) => /cached tools\/list/.test(l))).toBe(true);
  });

  it('works without a cache at all (legacy construction)', async () => {
    const http = httpWith(async () => okJsonResponse(CAPS));
    const t = new RemoteTransport({ http });
    const caps = await t.getCapabilities();
    expect(caps.version).toBe('0.9.1');
  });
});
