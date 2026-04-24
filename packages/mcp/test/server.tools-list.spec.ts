/**
 * `tools/list` tests.
 *
 * The MCP server advertises exactly the 4 tools committed to in Phase 10 A2:
 *   search_code, find_symbol, find_dependencies, get_file
 *
 * Even if the backend returns extra tools (it has ~9 today), we filter
 * down to the external surface. Missing backend tools still appear as
 * stubs so the MCP host sees a stable surface.
 */

import { McpServer } from '../src/server/server';
import { RemoteTransport, EXPOSED_TOOLS } from '../src/transport/remote-transport';
import {
  MockHttpClient,
  backendToolsListResult,
  okCapabilities,
} from './helpers';

describe('tools/list', () => {
  function makeServer(backendTools: string[]) {
    const http = new MockHttpClient()
      .on({
        match: (c) => c.path === '/mcp/capabilities',
        respond: () => ({ body: okCapabilities() }),
      })
      .on({
        match: (c) =>
          c.method === 'POST' &&
          c.path === '/mcp' &&
          (c.body as any)?.method === 'tools/list',
        respond: () => ({
          body: { jsonrpc: '2.0', id: 1, result: backendToolsListResult(backendTools) },
        }),
      });
    const server = new McpServer({ transport: new RemoteTransport({ http }) });
    return { server, http };
  }

  it('surfaces the 4 canonical MCP tools', async () => {
    const { server } = makeServer([
      'search_codebase',
      'find_symbol',
      'find_dependencies',
      'get_file',
      'generate_code', // extra — should be filtered out
    ]);
    // Prime capabilities cache — tools/list uses it for the stub fallback.
    await server.handle({ jsonrpc: '2.0', id: 0, method: 'initialize' });

    const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    const result = (res as any).result;
    expect(result.tools).toBeDefined();
    const names = (result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    expect(names).toEqual(EXPOSED_TOOLS.slice().sort());
    expect(names).toEqual(['find_dependencies', 'find_symbol', 'get_file', 'search_code']);
  });

  it('renames the backend name "search_codebase" to "search_code" on the wire', async () => {
    const { server } = makeServer(['search_codebase', 'find_symbol', 'find_dependencies', 'get_file']);
    await server.handle({ jsonrpc: '2.0', id: 0, method: 'initialize' });
    const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    const tools = (res as any).result.tools as Array<{ name: string; description: string }>;
    const searchCode = tools.find((t) => t.name === 'search_code');
    expect(searchCode).toBeDefined();
    expect(tools.find((t) => t.name === 'search_codebase')).toBeUndefined();
  });

  it('emits a stub for exposed tools the backend does not include', async () => {
    // Backend only returns 2 of the 4 exposed tools.
    const { server } = makeServer(['search_codebase', 'find_symbol']);
    // Capability list still advertises all 4.
    await server.handle({ jsonrpc: '2.0', id: 0, method: 'initialize' });

    const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = ((res as any).result.tools as Array<{ name: string }>).map((t) => t.name).sort();

    expect(names).toEqual(['find_dependencies', 'find_symbol', 'get_file', 'search_code']);
  });

  it('includes inputSchema of type "object" for every advertised tool', async () => {
    const { server } = makeServer(['search_codebase', 'find_symbol', 'find_dependencies', 'get_file']);
    await server.handle({ jsonrpc: '2.0', id: 0, method: 'initialize' });
    const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    for (const tool of (res as any).result.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.inputSchema.properties).toBe('object');
    }
  });
});
