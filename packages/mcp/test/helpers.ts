/**
 * Shared test helpers: a mock HttpClient that records requests and returns
 * scripted responses, plus a BackendCapabilities fixture.
 */

import type { HttpClient, HttpResponse } from '../src/transport/http-client';
import type { BackendCapabilities } from '../src/protocol';

export interface MockCall {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

export interface MockHandler {
  /** Match a request. Returns `true` to handle. */
  match: (call: MockCall) => boolean;
  respond: (call: MockCall) => Partial<HttpResponse> & { body?: unknown; ok?: boolean; status?: number };
}

export class MockHttpClient implements HttpClient {
  readonly calls: MockCall[] = [];
  private handlers: MockHandler[] = [];

  on(handler: MockHandler): this {
    this.handlers.push(handler);
    return this;
  }

  async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<HttpResponse> {
    const call: MockCall = { method, path, body };
    this.calls.push(call);
    for (const h of this.handlers) {
      if (h.match(call)) {
        const r = h.respond(call);
        const ok = r.ok ?? true;
        const status = r.status ?? (ok ? 200 : 500);
        const payload = r.body;
        return {
          ok,
          status,
          statusText: r.statusText ?? (ok ? 'OK' : 'Server Error'),
          text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
          json: async () => payload,
        };
      }
    }
    throw new Error(`MockHttpClient: no handler matched ${method} ${path}`);
  }
}

export function okCapabilities(overrides: Partial<BackendCapabilities> = {}): BackendCapabilities {
  return {
    version: '0.9.1',
    tools: ['search_code', 'find_symbol', 'find_dependencies', 'get_file'],
    features: { confidence_tags: false, incremental_cache: false },
    ...overrides,
  };
}

/** Shape of what the backend's MCP JSON-RPC endpoint returns for tools/list. */
export function backendToolsListResult(names: string[]) {
  return {
    tools: names.map((n) => ({
      name: n,
      description: `Backend tool ${n}`,
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Query' } },
        required: ['query'],
      },
    })),
  };
}
