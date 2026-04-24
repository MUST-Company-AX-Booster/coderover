import { Test, TestingModule } from '@nestjs/testing';
import { McpProtocolController } from './mcp-protocol.controller';
import { McpService } from './mcp.service';
import { Response } from 'express';

/** Minimal mock Response that captures JSON output */
function mockRes(): { res: Partial<Response>; getBody: () => any } {
  let body: string = '';
  const res: Partial<Response> = {
    setHeader: jest.fn().mockReturnThis(),
    send: jest.fn((data: string) => { body = data; return res as Response; }),
    end: jest.fn(),
    write: jest.fn(),
    flushHeaders: jest.fn(),
    writableEnded: false,
  };
  return { res, getBody: () => JSON.parse(body) };
}

describe('McpProtocolController', () => {
  let controller: McpProtocolController;
  let mcpService: { getTools: jest.Mock; executeTool: jest.Mock };

  const fakeTool = {
    name: 'search_codebase',
    description: 'Search code',
    parameters: [
      { name: 'query', type: 'string', description: 'Query', required: true },
    ],
  };

  beforeEach(async () => {
    mcpService = {
      getTools: jest.fn().mockReturnValue([fakeTool]),
      executeTool: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [McpProtocolController],
      providers: [{ provide: McpService, useValue: mcpService }],
    }).compile();

    controller = module.get<McpProtocolController>(McpProtocolController);
  });

  describe('initialize', () => {
    it('should return server info and capabilities', async () => {
      const { res, getBody } = mockRes();
      await controller.handleStreamable(
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'Trae' } } },
        res as Response,
      );
      const body = getBody();
      expect(body.result.serverInfo.name).toBe('coderover');
      expect(body.result.capabilities).toHaveProperty('tools');
      expect(body.result.protocolVersion).toBe('2024-11-05');
    });
  });

  describe('tools/list', () => {
    it('should return MCP-formatted tool list', async () => {
      const { res, getBody } = mockRes();
      await controller.handleStreamable(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        res as Response,
      );
      const body = getBody();
      expect(body.result.tools).toHaveLength(1);
      expect(body.result.tools[0].name).toBe('search_codebase');
      expect(body.result.tools[0]).toHaveProperty('inputSchema');
    });
  });

  describe('tools/call', () => {
    it('should execute a tool and return MCP content format', async () => {
      mcpService.executeTool.mockResolvedValue({
        toolName: 'search_codebase',
        args: { query: 'payment' },
        result: { results: [], totalFound: 0 },
        durationMs: 5,
      });

      const { res, getBody } = mockRes();
      await controller.handleStreamable(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'search_codebase', arguments: { query: 'payment' } },
        },
        res as Response,
      );
      const body = getBody();
      expect(body.result.isError).toBe(false);
      expect(Array.isArray(body.result.content)).toBe(true);
      expect(body.result.content[0].type).toBe('text');
    });

    it('should return isError=true when tool fails', async () => {
      mcpService.executeTool.mockResolvedValue({
        toolName: 'search_codebase',
        args: {},
        error: 'Missing query',
        durationMs: 2,
      });

      const { res, getBody } = mockRes();
      await controller.handleStreamable(
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search_codebase', arguments: {} } },
        res as Response,
      );
      const body = getBody();
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain('Missing query');
    });
  });

  describe('ping', () => {
    it('should return empty result', async () => {
      const { res, getBody } = mockRes();
      await controller.handleStreamable(
        { jsonrpc: '2.0', id: 5, method: 'ping' },
        res as Response,
      );
      const body = getBody();
      expect(body.result).toEqual({});
      expect(body.error).toBeUndefined();
    });
  });

  describe('unknown method', () => {
    it('should return method not found error', async () => {
      const { res, getBody } = mockRes();
      await controller.handleStreamable(
        { jsonrpc: '2.0', id: 6, method: 'resources/list' },
        res as Response,
      );
      const body = getBody();
      expect(body.error.code).toBe(-32601);
    });
  });
});
