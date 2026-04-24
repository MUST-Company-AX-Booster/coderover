import { Test, TestingModule } from '@nestjs/testing';
import { FindSymbolTool } from './find-symbol.tool';
import { SearchService } from '../../search/search.service';

describe('FindSymbolTool', () => {
  let tool: FindSymbolTool;
  let searchService: jest.Mocked<SearchService>;

  const mockResults = [
    {
      id: 'chunk-1',
      filePath: 'src/booking/booking.service.ts',
      moduleName: 'BookingModule',
      chunkText: 'export class BookingService { constructor() {} }',
      lineStart: 5,
      lineEnd: 50,
      similarity: 1.0,
      nestRole: 'service',
      symbols: [{ name: 'BookingService', kind: 'class' as const, exported: true, decorators: ['Injectable'], lineStart: 5, lineEnd: 50 }],
      imports: null,
    },
  ];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FindSymbolTool,
        {
          provide: SearchService,
          useValue: {
            findSymbol: jest.fn().mockResolvedValue(mockResults),
          },
        },
      ],
    }).compile();

    tool = module.get<FindSymbolTool>(FindSymbolTool);
    searchService = module.get(SearchService) as jest.Mocked<SearchService>;
  });

  it('should be defined', () => {
    expect(tool).toBeDefined();
  });

  it('should have name find_symbol', () => {
    expect(tool.name).toBe('find_symbol');
  });

  it('should call findSymbol with correct arguments', async () => {
    await tool.execute({ symbolName: 'BookingService' });
    expect(searchService.findSymbol).toHaveBeenCalledWith('BookingService', {
      repoId: undefined,
      kind: undefined,
    });
  });

  it('should call findSymbol with kind and repoId when provided', async () => {
    await tool.execute({ symbolName: 'BookingService', kind: 'class', repoId: 'repo-uuid' });
    expect(searchService.findSymbol).toHaveBeenCalledWith('BookingService', {
      repoId: 'repo-uuid',
      kind: 'class',
    });
  });

  it('should map results correctly', async () => {
    const result = await tool.execute({ symbolName: 'BookingService' });

    expect(result.symbolName).toBe('BookingService');
    expect(result.kind).toBe('any');
    expect(result.totalFound).toBe(1);
    expect(result.results[0].filePath).toBe('src/booking/booking.service.ts');
    expect(result.results[0].nestRole).toBe('service');
    expect(result.results[0].lines).toBe('5-50');
    expect(result.results[0].symbols).toHaveLength(1);
    expect(result.results[0].symbols[0].name).toBe('BookingService');
  });

  it('should return empty results when findSymbol returns []', async () => {
    (searchService.findSymbol as jest.Mock).mockResolvedValue([]);
    const result = await tool.execute({ symbolName: 'NonExistentClass' });
    expect(result.totalFound).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it('should truncate preview to 300 chars', async () => {
    const longText = 'x'.repeat(500);
    (searchService.findSymbol as jest.Mock).mockResolvedValue([
      { ...mockResults[0], chunkText: longText },
    ]);
    const result = await tool.execute({ symbolName: 'BookingService' });
    expect(result.results[0].preview).toHaveLength(300);
  });
});
