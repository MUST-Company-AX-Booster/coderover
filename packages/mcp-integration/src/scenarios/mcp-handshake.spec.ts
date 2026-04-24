/**
 * Phase 10 A5 — MCP handshake scenario.
 *
 * Drives the REAL `@coderover/mcp` client transports against the live
 * test backend — no handwritten fakes. This is the integration-test
 * counterpart to the unit tests in `packages/mcp/test/*.spec.ts`.
 *
 *   - RemoteTransport + FetchHttpClient → GET /mcp/capabilities
 *   - McpServer.initialize → server info + protocol version
 *   - tools/list via backend /mcp POST
 *   - min-backend-version override → CapabilityMismatchError
 */

import {
  FetchHttpClient,
  RemoteTransport,
  McpServer,
  CapabilityMismatchError,
  EXPOSED_TOOLS,
  MCP_PROTOCOL_VERSION,
} from '../../../mcp/src';
import { createTestUser, issueMcpToken } from '../setup/fixtures';
import { startTestBackend, TestBackend } from '../setup/test-backend';

/**
 * Get a real MCP token that carries every scope this scenario might need.
 * The MCP surface isn't scope-gated in the current backend (only
 * /citations/evidence is), but we mint with a full scope set so a future
 * scope-gated endpoint won't silently flip this suite to 403.
 */
async function mintBroadToken(backend: TestBackend): Promise<string> {
  const user = createTestUser();
  const { token } = await issueMcpToken(
    {
      tokenRevocation: backend.tokenRevocation,
      revokedTokensStore: backend.stores.revokedTokens,
    },
    user,
    ['citations:read', 'graph:read', 'search:read'],
  );
  return token;
}

describe('A5 — MCP handshake + tools/list', () => {
  let backend: TestBackend;
  let token: string;

  beforeAll(async () => {
    backend = await startTestBackend();
    token = await mintBroadToken(backend);
  });

  afterAll(async () => {
    if (backend) await backend.stop();
  });

  function makeTransport(minBackendVersion?: string) {
    const http = new FetchHttpClient({ baseUrl: backend.baseUrl, token });
    return new RemoteTransport({ http, minBackendVersion });
  }

  it('fetches capabilities with the canonical tool set', async () => {
    const transport = makeTransport('0.0.0'); // always pass version gate
    const caps = await transport.getCapabilities();

    expect(typeof caps.version).toBe('string');
    expect(caps.version).toMatch(/\d+\.\d+\.\d+/);
    // All 4 canonical tools surface via the external name map.
    for (const expected of EXPOSED_TOOLS) {
      expect(caps.tools).toContain(expected);
    }
    expect(caps.features).toMatchObject({
      confidence_tags: expect.any(Boolean),
      incremental_cache: expect.any(Boolean),
    });
  });

  it('McpServer.initialize returns protocol version + backend block', async () => {
    const transport = makeTransport('0.0.0');
    const server = new McpServer({ transport });

    const res = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'a5-integration' } },
    });

    expect(res).not.toBeNull();
    expect(res).toHaveProperty('result');
    const r = (res as any).result;
    expect(r.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(r.serverInfo.name).toBe('coderover-mcp');
    expect(r.capabilities.tools.listChanged).toBe(false);
    expect(typeof r.backend.version).toBe('string');
    expect(r.backend.features).toMatchObject({
      confidence_tags: expect.any(Boolean),
      incremental_cache: expect.any(Boolean),
    });
  });

  it('tools/list surfaces the 4 canonical tools through the server', async () => {
    const transport = makeTransport('0.0.0');
    const server = new McpServer({ transport });
    // MCP hosts send initialize before tools/list; do the same so any
    // implicit state the server relies on is set up.
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

    const res = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });

    expect(res).toHaveProperty('result');
    const tools = (res as any).result.tools as Array<{ name: string }>;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPOSED_TOOLS].sort());
  });

  it('rejects a too-old backend with CapabilityMismatchError', async () => {
    // 99.x would require the backend to be from the far future. The
    // current backend version (see coderover-api/package.json) is well
    // below 99.0.0, so the gate must fire.
    const transport = makeTransport('99.0.0');
    await expect(transport.getCapabilities()).rejects.toBeInstanceOf(
      CapabilityMismatchError,
    );
  });
});
