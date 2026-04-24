/**
 * `initialize` handshake tests.
 *
 * Cover:
 *   - Returns protocolVersion, serverInfo.name, and server capabilities.
 *   - Surfaces backend version + features in the result envelope.
 *   - Fails cleanly with JSON-RPC -32000 when the backend is too old
 *     (capability mismatch).
 *   - Fails cleanly with JSON-RPC -32001 when the backend is unreachable.
 */

import { McpServer } from '../src/server/server';
import { RemoteTransport } from '../src/transport/remote-transport';
import { RpcErrorCode, MCP_PROTOCOL_VERSION } from '../src/protocol';
import { MockHttpClient, okCapabilities } from './helpers';

describe('initialize handshake', () => {
  it('returns protocolVersion, serverInfo, and backend features', async () => {
    const http = new MockHttpClient().on({
      match: (c) => c.method === 'GET' && c.path === '/mcp/capabilities',
      respond: () => ({ body: okCapabilities({ version: '0.10.0', features: { confidence_tags: true, incremental_cache: true } }) }),
    });
    const server = new McpServer({ transport: new RemoteTransport({ http }) });

    const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });

    expect(res).not.toBeNull();
    expect('result' in res!).toBe(true);
    const result = (res as any).result;
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(result.serverInfo.name).toBe('coderover-mcp');
    expect(result.capabilities.tools).toBeDefined();
    expect(result.backend.version).toBe('0.10.0');
    expect(result.backend.features.confidence_tags).toBe(true);
    expect(result.backend.features.incremental_cache).toBe(true);
  });

  it('fails with CapabilityMismatch error when backend is too old', async () => {
    const http = new MockHttpClient().on({
      match: (c) => c.path === '/mcp/capabilities',
      respond: () => ({ body: okCapabilities({ version: '0.5.0' }) }),
    });
    const server = new McpServer({
      transport: new RemoteTransport({ http, minBackendVersion: '0.9.0' }),
    });

    const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });

    expect(res).not.toBeNull();
    expect('error' in res!).toBe(true);
    const err = (res as any).error;
    expect(err.code).toBe(RpcErrorCode.CapabilityMismatch);
    expect(err.message).toMatch(/0\.5\.0/);
    expect(err.message).toMatch(/0\.9\.0/);
    expect(err.data.backendVersion).toBe('0.5.0');
    expect(err.data.minRequired).toBe('0.9.0');
  });

  it('returns BackendUnreachable when capabilities endpoint returns non-2xx', async () => {
    const http = new MockHttpClient().on({
      match: (c) => c.path === '/mcp/capabilities',
      respond: () => ({ ok: false, status: 503, statusText: 'Service Unavailable', body: null }),
    });
    const server = new McpServer({ transport: new RemoteTransport({ http }) });

    const res = await server.handle({ jsonrpc: '2.0', id: 9, method: 'initialize' });

    expect('error' in res!).toBe(true);
    const err = (res as any).error;
    expect(err.code).toBe(RpcErrorCode.BackendUnreachable);
    expect(err.message).toMatch(/503/);
  });

  it('returns BackendUnreachable when capabilities payload is malformed', async () => {
    const http = new MockHttpClient().on({
      match: (c) => c.path === '/mcp/capabilities',
      respond: () => ({ body: { wrong: 'shape' } }),
    });
    const server = new McpServer({ transport: new RemoteTransport({ http }) });

    const res = await server.handle({ jsonrpc: '2.0', id: 10, method: 'initialize' });

    expect('error' in res!).toBe(true);
    const err = (res as any).error;
    expect(err.code).toBe(RpcErrorCode.BackendUnreachable);
    expect(err.message).toMatch(/unexpected shape/i);
  });

  it('treats notifications/initialized as a no-op (no response)', async () => {
    const http = new MockHttpClient().on({
      match: () => true,
      respond: () => ({ body: okCapabilities() }),
    });
    const server = new McpServer({ transport: new RemoteTransport({ http }) });

    const res = await server.handle({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(res).toBeNull();
  });
});
