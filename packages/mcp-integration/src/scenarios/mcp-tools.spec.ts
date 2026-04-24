/**
 * Phase 10 A5 — MCP tool dispatch.
 *
 * Drives `tools/call` through the real RemoteTransport against the live
 * backend. The test-backend's `CannedMcpService` resolves tools to
 * in-memory payloads that mimic what SearchService + graph would produce.
 *
 * We assert:
 *   - search_code returns hits with a confidence tag + score.
 *   - find_symbol returns a node_id matching `computeNodeId(...)` from
 *     the public deterministic-ids helper in coderover-api.
 *   - find_dependencies returns both upstream/downstream lists.
 *
 * The point isn't to re-test the underlying search (those have unit
 * tests); it's to prove the JSON-RPC round-trip + name mapping +
 * scope-unchecked tool surface all align end-to-end.
 */

import {
  FetchHttpClient,
  RemoteTransport,
  McpServer,
} from '../../../mcp/src';
import { computeNodeId } from '../../../../coderover-api/src/graph/deterministic-ids';
import { createTestUser, issueMcpToken } from '../setup/fixtures';
import { startTestBackend, TestBackend } from '../setup/test-backend';

/** Small inline fixture "files" — 5 TS-flavored chunks. No temp-dir I/O. */
const FIXTURE_FILES = [
  {
    path: 'src/auth/auth.service.ts',
    lines: [1, 80],
    symbol: { name: 'AuthService', kind: 'class' },
  },
  {
    path: 'src/auth/jwt.strategy.ts',
    lines: [1, 40],
    symbol: { name: 'JwtStrategy', kind: 'class' },
  },
  {
    path: 'src/citations/citations.service.ts',
    lines: [1, 270],
    symbol: { name: 'CitationsService', kind: 'class' },
  },
  {
    path: 'src/graph/memgraph.service.ts',
    lines: [1, 80],
    symbol: { name: 'MemgraphService', kind: 'class' },
  },
  {
    path: 'src/mcp/mcp.service.ts',
    lines: [1, 140],
    symbol: { name: 'McpService', kind: 'class' },
  },
];

describe('A5 — MCP tool dispatch', () => {
  let backend: TestBackend;
  let token: string;

  beforeAll(async () => {
    backend = await startTestBackend();
    const user = createTestUser();
    ({ token } = await issueMcpToken(
      {
        tokenRevocation: backend.tokenRevocation,
        revokedTokensStore: backend.stores.revokedTokens,
      },
      user,
      ['citations:read', 'graph:read', 'search:read'],
    ));
  });

  afterAll(async () => {
    if (backend) await backend.stop();
  });

  beforeEach(() => {
    backend.mcp.reset();
  });

  function makeServer() {
    const http = new FetchHttpClient({ baseUrl: backend.baseUrl, token });
    const transport = new RemoteTransport({ http, minBackendVersion: '0.0.0' });
    return new McpServer({ transport });
  }

  it('search_code dispatches via tools/call and returns tagged hits', async () => {
    // The external name is `search_code`; backend name is `search_codebase`.
    // Transport translates on the way in.
    backend.mcp.onTool('search_codebase', async (args) => {
      expect(args).toEqual({ query: 'auth guard' });
      return {
        query: 'auth guard',
        results: FIXTURE_FILES.slice(0, 3).map((f) => ({
          filePath: f.path,
          lineStart: f.lines[0],
          lineEnd: f.lines[1],
          preview: `// ${f.path}`,
          confidence: 'INFERRED',
          confidence_score: 0.72,
        })),
      };
    });

    const server = makeServer();
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

    const res = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'search_code', arguments: { query: 'auth guard' } },
    });

    expect(res).toHaveProperty('result');
    const result = (res as any).result;
    expect(result.isError).toBe(false);
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.results).toHaveLength(3);
    expect(parsed.results[0]).toMatchObject({
      confidence: 'INFERRED',
      confidence_score: expect.any(Number),
    });
  });

  it('find_symbol returns a payload whose node_id matches computeNodeId()', async () => {
    const target = FIXTURE_FILES[0];
    const expectedNodeId = computeNodeId(
      target.path,
      target.symbol.kind,
      target.symbol.name,
    );

    backend.mcp.onTool('find_symbol', async (args) => {
      expect(args).toEqual({ symbolName: 'AuthService' });
      return {
        symbolName: 'AuthService',
        results: [
          {
            filePath: target.path,
            lineStart: target.lines[0],
            lineEnd: target.lines[1],
            node_id: expectedNodeId,
            confidence: 'EXTRACTED',
            confidence_score: 1.0,
          },
        ],
        totalFound: 1,
      };
    });

    const server = makeServer();
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

    const res = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'find_symbol',
        arguments: { symbolName: 'AuthService' },
      },
    });

    const result = (res as any).result;
    const payload = JSON.parse(result.content[0].text);
    expect(payload.totalFound).toBe(1);
    expect(payload.results[0].node_id).toBe(expectedNodeId);
    expect(payload.results[0].confidence).toBe('EXTRACTED');
  });

  it('find_dependencies returns upstream + downstream with confidence', async () => {
    backend.mcp.onTool('find_dependencies', async () => ({
      target: 'src/auth/auth.service.ts',
      upstream: [
        {
          filePath: 'src/auth/auth.controller.ts',
          confidence: 'EXTRACTED',
          confidence_score: 1.0,
        },
      ],
      downstream: [
        {
          filePath: 'src/auth/jwt.strategy.ts',
          confidence: 'INFERRED',
          confidence_score: 0.6,
        },
      ],
    }));

    const server = makeServer();
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

    const res = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'find_dependencies',
        arguments: { target: 'src/auth/auth.service.ts' },
      },
    });

    const result = (res as any).result;
    const payload = JSON.parse(result.content[0].text);
    expect(payload.upstream).toHaveLength(1);
    expect(payload.downstream).toHaveLength(1);
    expect(payload.upstream[0].confidence).toBe('EXTRACTED');
    expect(payload.downstream[0].confidence).toBe('INFERRED');
  });

  it('an unknown tool returns isError: true (not a JSON-RPC error)', async () => {
    const server = makeServer();
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

    // The backend's McpService contract says "unknown tool → ToolCall.error
    // set, RPC layer surfaces it as content + isError". Our CannedMcpService
    // mirrors that: returns an envelope with no `result` field, so the
    // MCP controller's `if (call.error)` branch fires.
    backend.mcp.executeTool = (async (toolName: string, args: any) => ({
      toolName,
      args,
      durationMs: 1,
      error: `Tool "${toolName}" not found`,
    })) as unknown as typeof backend.mcp.executeTool;

    const res = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'find_symbol', arguments: { symbolName: 'Nope' } },
    });

    const result = (res as any).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Tool "find_symbol" not found|Error:/);
  });
});
