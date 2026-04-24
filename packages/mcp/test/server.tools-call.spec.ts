/**
 * `tools/call` tests.
 *
 * The MCP server is a proxy — when an agent calls `search_code`, the request
 * must hit the backend as `search_codebase` (name mapping) and the response
 * content blocks must come back untouched.
 */

import { McpServer } from '../src/server/server';
import { RemoteTransport } from '../src/transport/remote-transport';
import { MockHttpClient, okCapabilities } from './helpers';

describe('tools/call', () => {
  it('routes to POST /mcp with the mapped backend tool name', async () => {
    const http = new MockHttpClient()
      .on({
        match: (c) => c.path === '/mcp/capabilities',
        respond: () => ({ body: okCapabilities() }),
      })
      .on({
        match: (c) =>
          c.method === 'POST' &&
          c.path === '/mcp' &&
          (c.body as any)?.method === 'tools/call',
        respond: (c) => {
          const params = (c.body as any).params;
          return {
            body: {
              jsonrpc: '2.0',
              id: (c.body as any).id,
              result: {
                content: [
                  { type: 'text', text: `called ${params.name} with ${JSON.stringify(params.arguments)}` },
                ],
                isError: false,
              },
            },
          };
        },
      });
    const server = new McpServer({ transport: new RemoteTransport({ http }) });

    const res = await server.handle({
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'search_code', arguments: { query: 'payment flow' } },
    });

    const result = (res as any).result;
    expect(result.isError).toBe(false);
    expect(result.content[0].type).toBe('text');
    // Verify the outbound request used the backend name, not the external name.
    const rpcCall = http.calls.find(
      (c) => c.method === 'POST' && c.path === '/mcp' && (c.body as any).method === 'tools/call',
    );
    expect(rpcCall).toBeDefined();
    expect((rpcCall!.body as any).params.name).toBe('search_codebase');
    expect((rpcCall!.body as any).params.arguments).toEqual({ query: 'payment flow' });
  });

  it('passes identity-mapped tool names through unchanged', async () => {
    const http = new MockHttpClient()
      .on({
        match: (c) => c.path === '/mcp/capabilities',
        respond: () => ({ body: okCapabilities() }),
      })
      .on({
        match: (c) => c.method === 'POST' && c.path === '/mcp',
        respond: (c) => ({
          body: {
            jsonrpc: '2.0',
            id: (c.body as any).id,
            result: {
              content: [{ type: 'text', text: 'ok' }],
              isError: false,
            },
          },
        }),
      });
    const server = new McpServer({ transport: new RemoteTransport({ http }) });

    for (const toolName of ['find_symbol', 'find_dependencies', 'get_file']) {
      await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: {} },
      });
      const lastRpc = [...http.calls]
        .reverse()
        .find((c) => c.method === 'POST' && c.path === '/mcp' && (c.body as any).method === 'tools/call');
      expect((lastRpc!.body as any).params.name).toBe(toolName);
    }
  });

  it('surfaces isError=true for tool-level failures', async () => {
    const http = new MockHttpClient()
      .on({
        match: (c) => c.path === '/mcp/capabilities',
        respond: () => ({ body: okCapabilities() }),
      })
      .on({
        match: (c) => c.method === 'POST' && c.path === '/mcp',
        respond: (c) => ({
          body: {
            jsonrpc: '2.0',
            id: (c.body as any).id,
            result: {
              content: [{ type: 'text', text: 'Error: missing parameter query' }],
              isError: true,
            },
          },
        }),
      });
    const server = new McpServer({ transport: new RemoteTransport({ http }) });

    const res = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'search_code', arguments: {} },
    });
    expect((res as any).result.isError).toBe(true);
    expect((res as any).result.content[0].text).toMatch(/missing parameter/i);
  });

  it('returns isError=true if params.name is missing', async () => {
    const http = new MockHttpClient().on({
      match: () => true,
      respond: () => ({ body: okCapabilities() }),
    });
    const server = new McpServer({ transport: new RemoteTransport({ http }) });

    const res = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { arguments: {} },
    });
    expect((res as any).result.isError).toBe(true);
    expect((res as any).result.content[0].text).toMatch(/requires params\.name/i);
  });

  it('returns method-not-found for unknown RPC methods', async () => {
    const http = new MockHttpClient().on({
      match: () => true,
      respond: () => ({ body: okCapabilities() }),
    });
    const server = new McpServer({ transport: new RemoteTransport({ http }) });

    const res = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/list',
    });
    expect((res as any).error.code).toBe(-32601);
  });
});
