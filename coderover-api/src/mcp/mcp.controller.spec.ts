import { Test, TestingModule } from '@nestjs/testing';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

describe('McpController', () => {
  let controller: McpController;
  let mcpService: { executeTool: jest.Mock; getTools: jest.Mock };

  beforeEach(async () => {
    mcpService = {
      executeTool: jest.fn(),
      getTools: jest.fn().mockReturnValue([
        { name: 'search_codebase', description: '', parameters: [] },
        { name: 'find_symbol', description: '', parameters: [] },
        { name: 'find_dependencies', description: '', parameters: [] },
      ]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [McpController],
      providers: [{ provide: McpService, useValue: mcpService }],
    }).compile();

    controller = module.get<McpController>(McpController);
  });

  it('should always return results as an array', async () => {
    mcpService.executeTool.mockResolvedValue({
      toolName: 'find_symbol',
      args: { symbolName: 'PaymentConfirmation' },
      result: { symbolName: 'PaymentConfirmation', totalFound: 0 },
      durationMs: 3,
    });

    const res = await controller.execute({
      tool: 'find_symbol',
      args: { symbolName: 'PaymentConfirmation' },
    });

    expect(Array.isArray(res.results)).toBe(true);
    expect(res.results).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.error).toBeNull();
  });

  it('should return ok=false when executeTool returns an error', async () => {
    mcpService.executeTool.mockResolvedValue({
      toolName: 'find_symbol',
      args: {},
      error: 'Tool failed',
      durationMs: 2,
    });

    const res = await controller.execute({ tool: 'find_symbol', args: {} });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('Tool failed');
    expect(res.results).toEqual([]);
  });

  describe('GET /mcp/capabilities', () => {
    it('returns version, tool name list, and feature flags', () => {
      const caps = controller.capabilities();
      expect(typeof caps.version).toBe('string');
      expect(caps.version.length).toBeGreaterThan(0);
      expect(Array.isArray(caps.tools)).toBe(true);
      expect(caps.tools).toEqual(['search_codebase', 'find_symbol', 'find_dependencies']);
      expect(caps.features).toEqual({ confidence_tags: false, incremental_cache: false });
    });
  });
});

