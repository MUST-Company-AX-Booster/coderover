/**
 * LocalTransport tests — Phase 11 Wave 1 (L3).
 *
 * These exercise the fixture-backed skeleton directly via its `Transport`
 * surface and mounted inside an `McpServer` to prove that the local path is
 * drop-in compatible with the remote path. Wave 2+ swaps the fixtures for
 * real DB-backed queries; when that lands, only the "returns fixture ..."
 * tests here should need to change.
 */

import {
  LocalTransport,
  DEFAULT_FIXTURES,
  LOCAL_EXPOSED_TOOLS,
  type Fixtures,
} from '../../src/transport/local-transport';
import { McpServer } from '../../src/server/server';
import { computeNodeId } from '../../src/local/deterministic-ids';
import { MCP_PROTOCOL_VERSION, RpcErrorCode } from '../../src/protocol';
import { getPackageVersion } from '../../src/version';

describe('LocalTransport (L3 skeleton)', () => {
  describe('capabilities()', () => {
    it('reports local_mode: true and backendVersion prefixed with the package version', () => {
      const t = new LocalTransport();
      const caps = t.capabilities();
      expect(caps.features.local_mode).toBe(true);
      expect(caps.features.streaming).toBe(false);
      expect(caps.features.confidence_tags).toBe(true);
      // backendVersion now reads `${packageVersion}-local` straight from
      // package.json so it tracks each publish without a hardcoded bump.
      expect(caps.backendVersion).toBe(`${getPackageVersion()}-local`);
      expect(caps.backendVersion).toContain('local');
      expect(caps.minClientVersion).toBe('0.1.0');
      expect(caps.protocolVersion).toBe('0.1.0');
      expect(caps.tools.sort()).toEqual(
        [...LOCAL_EXPOSED_TOOLS].sort(),
      );
    });

    it('getCapabilities() returns a BackendCapabilities that McpServer can consume', async () => {
      const t = new LocalTransport();
      const caps = await t.getCapabilities();
      expect(typeof caps.version).toBe('string');
      expect(caps.features.confidence_tags).toBe(true);
      expect(caps.features.incremental_cache).toBe(false);
      expect(caps.tools).toEqual([...LOCAL_EXPOSED_TOOLS]);
    });
  });

  describe('listTools()', () => {
    it('returns exactly 3 tools, each with name, description, and object inputSchema', async () => {
      const t = new LocalTransport();
      const tools = await t.listTools();
      expect(tools).toHaveLength(3);
      const names = tools.map((x) => x.name).sort();
      expect(names).toEqual(['find_dependencies', 'find_symbol', 'search_code']);
      for (const tool of tools) {
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.inputSchema.type).toBe('object');
        expect(typeof tool.inputSchema.properties).toBe('object');
      }
    });

    it('returns a defensive copy — mutating the result does not leak into future calls', async () => {
      const t = new LocalTransport();
      const first = await t.listTools();
      (first[0] as { name: string }).name = 'mutated';
      const second = await t.listTools();
      expect(second.map((x) => x.name)).not.toContain('mutated');
    });
  });

  describe('callTool()', () => {
    it('search_code returns fixture with 1+ results and confidence: "EXTRACTED"', async () => {
      const t = new LocalTransport();
      const res = await t.callTool('search_code', { query: 'auth guard' });
      expect(res.isError).toBe(false);
      expect(res.content[0].type).toBe('text');
      const payload = JSON.parse(res.content[0].text);
      expect(payload.query).toBe('auth guard');
      expect(Array.isArray(payload.results)).toBe(true);
      expect(payload.results.length).toBeGreaterThanOrEqual(1);
      expect(payload.results[0].confidence).toBe('EXTRACTED');
      expect(payload.results[0].confidence_score).toBe(1.0);
    });

    it('find_symbol returns a result whose node_id matches computeNodeId(src/auth/auth.service.ts, class, AuthService)', async () => {
      const t = new LocalTransport();
      const res = await t.callTool('find_symbol', { symbolName: 'AuthService' });
      expect(res.isError).toBe(false);
      const payload = JSON.parse(res.content[0].text);
      const expectedNodeId = computeNodeId(
        'src/auth/auth.service.ts',
        'class',
        'AuthService',
      );
      expect(payload.symbolName).toBe('AuthService');
      expect(payload.totalFound).toBe(1);
      expect(payload.results[0].node_id).toBe(expectedNodeId);
      expect(payload.results[0].confidence).toBe('EXTRACTED');
    });

    it('find_dependencies returns both upstream and downstream arrays', async () => {
      const t = new LocalTransport();
      const res = await t.callTool('find_dependencies', {
        target: 'src/auth/auth.service.ts',
      });
      expect(res.isError).toBe(false);
      const payload = JSON.parse(res.content[0].text);
      expect(payload.target).toBe('src/auth/auth.service.ts');
      expect(Array.isArray(payload.upstream)).toBe(true);
      expect(Array.isArray(payload.downstream)).toBe(true);
      expect(payload.upstream.length).toBeGreaterThanOrEqual(1);
      expect(payload.downstream.length).toBeGreaterThanOrEqual(1);
    });

    it('unknown tool returns isError: true with a human message (not a thrown error)', async () => {
      const t = new LocalTransport();
      const res = await t.callTool('does_not_exist', {});
      expect(res.isError).toBe(true);
      expect(res.content[0].type).toBe('text');
      expect(res.content[0].text).toMatch(/Tool "does_not_exist" not found/);
    });

    it('custom fixtures via constructor option override defaults', async () => {
      const customFixtures: Partial<Fixtures> = {
        search_code: {
          payload: {
            query: '<custom>',
            results: [
              {
                filePath: 'custom/fake.ts',
                lineStart: 10,
                lineEnd: 20,
                preview: 'custom preview',
                confidence: 'INFERRED',
                confidence_score: 0.42,
              },
            ],
          },
        },
      };
      const t = new LocalTransport({ fixtures: customFixtures });
      const res = await t.callTool('search_code', { query: 'anything' });
      const payload = JSON.parse(res.content[0].text);
      expect(payload.results[0].filePath).toBe('custom/fake.ts');
      expect(payload.results[0].confidence).toBe('INFERRED');
      expect(payload.results[0].confidence_score).toBe(0.42);

      // Non-overridden fixtures still fall back to defaults.
      const symRes = await t.callTool('find_symbol', { symbolName: 'X' });
      const symPayload = JSON.parse(symRes.content[0].text);
      expect(symPayload.results[0].node_id).toBe(
        (DEFAULT_FIXTURES.find_symbol.payload as any).results[0].node_id,
      );
    });
  });

  describe('end-to-end via McpServer', () => {
    it('initialize returns the expected handshake envelope', async () => {
      const transport = new LocalTransport();
      const server = new McpServer({ transport });
      const res = await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
      });
      expect(res).not.toBeNull();
      expect('result' in res!).toBe(true);
      const result = (res as any).result;
      expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
      expect(result.serverInfo.name).toBe('coderover-mcp');
      expect(result.backend.version).toMatch(/local/);
      expect(result.backend.features.confidence_tags).toBe(true);
    });

    it('tools/list surfaces the 3 local tools through the server', async () => {
      const transport = new LocalTransport();
      const server = new McpServer({ transport });
      await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
      const res = await server.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });
      const tools = (res as any).result.tools as Array<{ name: string }>;
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['find_dependencies', 'find_symbol', 'search_code']);
    });

    it('tools/call find_symbol round-trips the expected node_id through the server', async () => {
      const transport = new LocalTransport();
      const server = new McpServer({ transport });
      await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
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
      expect(result.isError).toBe(false);
      const payload = JSON.parse(result.content[0].text);
      const expected = computeNodeId(
        'src/auth/auth.service.ts',
        'class',
        'AuthService',
      );
      expect(payload.results[0].node_id).toBe(expected);
    });

    it('an unknown JSON-RPC method returns -32601 (method not found)', async () => {
      const transport = new LocalTransport();
      const server = new McpServer({ transport });
      const res = await server.handle({
        jsonrpc: '2.0',
        id: 99,
        method: 'resources/list',
      });
      expect(res).not.toBeNull();
      expect('error' in res!).toBe(true);
      expect((res as any).error.code).toBe(RpcErrorCode.MethodNotFound);
    });

    it('tools/call with an unknown tool returns isError: true via the server', async () => {
      const transport = new LocalTransport();
      const server = new McpServer({ transport });
      await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
      const res = await server.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'nope_not_real', arguments: {} },
      });
      const result = (res as any).result;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not found/i);
    });
  });
});
