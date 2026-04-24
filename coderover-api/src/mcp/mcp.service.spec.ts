import { Test, TestingModule } from '@nestjs/testing';
import { McpService } from './mcp.service';
import { SearchCodebaseTool } from './tools/search-codebase.tool';
import { GetModuleSummaryTool } from './tools/get-module-summary.tool';
import { GetApiEndpointsTool } from './tools/get-api-endpoints.tool';
import { GenerateCodeTool } from './tools/generate-code.tool';
import { FindSymbolTool } from './tools/find-symbol.tool';
import { FindDependenciesTool } from './tools/find-dependencies.tool';
import { ReviewPrTool } from './tools/review-pr.tool';
import { QueryCodeGraphTool } from './tools/query-code-graph.tool';
import { GraphAnalysisTool } from './tools/graph-analysis.tool';

const makeMockTool = (name: string) => ({
  name,
  description: `${name} description`,
  parameters: [
    { name: 'query', type: 'string' as const, description: 'test', required: true },
  ],
  execute: jest.fn().mockResolvedValue({ data: `${name} result` }),
});

describe('McpService', () => {
  let service: McpService;
  let searchTool: ReturnType<typeof makeMockTool>;
  let moduleSummaryTool: ReturnType<typeof makeMockTool>;
  let apiEndpointsTool: ReturnType<typeof makeMockTool>;
  let generateCodeTool: ReturnType<typeof makeMockTool>;
  let findSymbolTool: ReturnType<typeof makeMockTool>;
  let findDependenciesTool: ReturnType<typeof makeMockTool>;
  let reviewPrTool: ReturnType<typeof makeMockTool>;
  let queryCodeGraphTool: ReturnType<typeof makeMockTool>;
  let graphAnalysisTool: ReturnType<typeof makeMockTool>;

  beforeEach(async () => {
    searchTool = makeMockTool('search_codebase');
    moduleSummaryTool = makeMockTool('get_module_summary');
    apiEndpointsTool = makeMockTool('get_api_endpoints');
    generateCodeTool = makeMockTool('generate_code');
    findSymbolTool = makeMockTool('find_symbol');
    findDependenciesTool = makeMockTool('find_dependencies');
    reviewPrTool = makeMockTool('review_pull_request');
    queryCodeGraphTool = makeMockTool('query_code_graph');
    graphAnalysisTool = makeMockTool('graph_analysis');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpService,
        { provide: SearchCodebaseTool, useValue: searchTool },
        { provide: GetModuleSummaryTool, useValue: moduleSummaryTool },
        { provide: GetApiEndpointsTool, useValue: apiEndpointsTool },
        { provide: GenerateCodeTool, useValue: generateCodeTool },
        { provide: FindSymbolTool, useValue: findSymbolTool },
        { provide: FindDependenciesTool, useValue: findDependenciesTool },
        { provide: ReviewPrTool, useValue: reviewPrTool },
        { provide: QueryCodeGraphTool, useValue: queryCodeGraphTool },
        { provide: GraphAnalysisTool, useValue: graphAnalysisTool },
      ],
    }).compile();

    service = module.get<McpService>(McpService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('getTools should return all 9 registered tools', () => {
    const tools = service.getTools();
    expect(tools).toHaveLength(9);
    const names = tools.map((t) => t.name);
    expect(names).toContain('search_codebase');
    expect(names).toContain('get_module_summary');
    expect(names).toContain('get_api_endpoints');
    expect(names).toContain('generate_code');
    expect(names).toContain('find_symbol');
    expect(names).toContain('find_dependencies');
    expect(names).toContain('review_pull_request');
    expect(names).toContain('query_code_graph');
    expect(names).toContain('graph_analysis');
  });

  it('getToolsForOpenAI should return correct function-calling format', () => {
    const openAITools = service.getToolsForOpenAI();
    expect(openAITools).toHaveLength(9);

    const first = openAITools[0];
    expect(first.type).toBe('function');
    expect(first.function.name).toBeDefined();
    expect(first.function.description).toBeDefined();
    const params = first.function.parameters;
    expect(params).toBeDefined();
    expect(params!.type).toBe('object');
    expect((params as any).properties).toBeDefined();
    expect((params as any).required).toBeInstanceOf(Array);
  });

  it('executeTool should execute a registered tool and return result with durationMs', async () => {
    const result = await service.executeTool('search_codebase', { query: 'auth' });

    expect(searchTool.execute).toHaveBeenCalledWith({ query: 'auth' });
    expect(result.toolName).toBe('search_codebase');
    expect(result.result).toEqual({ data: 'search_codebase result' });
    expect(result.error).toBeUndefined();
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('executeTool should return error for nonexistent tool', async () => {
    const result = await service.executeTool('nonexistent_tool', {});

    expect(result.toolName).toBe('nonexistent_tool');
    expect(result.error).toContain('not found');
    expect(result.result).toBeUndefined();
    expect(typeof result.durationMs).toBe('number');
  });

  it('executeTool should execute find_symbol tool', async () => {
    const result = await service.executeTool('find_symbol', { symbolName: 'BookingService' });
    expect(findSymbolTool.execute).toHaveBeenCalledWith({ symbolName: 'BookingService' });
    expect(result.toolName).toBe('find_symbol');
    expect(result.error).toBeUndefined();
  });

  it('executeTool should execute find_dependencies tool', async () => {
    const result = await service.executeTool('find_dependencies', { importPath: 'booking.service' });
    expect(findDependenciesTool.execute).toHaveBeenCalledWith({ importPath: 'booking.service' });
    expect(result.toolName).toBe('find_dependencies');
    expect(result.error).toBeUndefined();
  });
});
