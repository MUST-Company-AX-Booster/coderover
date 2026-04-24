import { Test, TestingModule } from '@nestjs/testing';
import { FindDependenciesTool } from './find-dependencies.tool';
import { SearchService } from '../../search/search.service';

describe('FindDependenciesTool', () => {
  let tool: FindDependenciesTool;
  let searchService: jest.Mocked<SearchService>;

  const mockResults = [
    {
      id: 'chunk-1',
      filePath: 'src/booking/booking.controller.ts',
      moduleName: 'BookingModule',
      chunkText: 'import { BookingService } from "./booking.service"',
      lineStart: 1,
      lineEnd: 30,
      similarity: 1.0,
      nestRole: 'controller',
      symbols: null,
      imports: [
        { source: './booking.service', names: ['BookingService'], isRelative: true },
        { source: '@nestjs/common', names: ['Controller', 'Get'], isRelative: false },
      ],
    },
    {
      id: 'chunk-2',
      filePath: 'src/booking/booking.module.ts',
      moduleName: 'BookingModule',
      chunkText: 'import { BookingService } from "./booking.service"',
      lineStart: 1,
      lineEnd: 20,
      similarity: 1.0,
      nestRole: 'module',
      symbols: null,
      imports: [
        { source: './booking.service', names: ['BookingService'], isRelative: true },
      ],
    },
  ];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FindDependenciesTool,
        {
          provide: SearchService,
          useValue: {
            findByImport: jest.fn().mockResolvedValue(mockResults),
          },
        },
      ],
    }).compile();

    tool = module.get<FindDependenciesTool>(FindDependenciesTool);
    searchService = module.get(SearchService) as jest.Mocked<SearchService>;
  });

  it('should be defined', () => {
    expect(tool).toBeDefined();
  });

  it('should have name find_dependencies', () => {
    expect(tool.name).toBe('find_dependencies');
  });

  it('should call findByImport with correct importPath', async () => {
    await tool.execute({ importPath: 'booking.service' });
    expect(searchService.findByImport).toHaveBeenCalledWith('booking.service', {
      repoId: undefined,
    });
  });

  it('should call findByImport with repoId when provided', async () => {
    await tool.execute({ importPath: 'booking.service', repoId: 'repo-uuid' });
    expect(searchService.findByImport).toHaveBeenCalledWith('booking.service', {
      repoId: 'repo-uuid',
    });
  });

  it('should deduplicate results by filePath', async () => {
    // Duplicate same filePath
    const duplicateResults = [
      ...mockResults,
      { ...mockResults[0], id: 'chunk-1b' }, // same filePath as chunk-1
    ];
    (searchService.findByImport as jest.Mock).mockResolvedValue(duplicateResults);

    const result = await tool.execute({ importPath: 'booking.service' });

    // Should only have 2 unique files (controller and module)
    expect(result.totalFound).toBe(2);
    expect(result.dependentFiles).toHaveLength(2);
  });

  it('should return correct dependentFiles structure', async () => {
    const result = await tool.execute({ importPath: 'booking.service' });

    expect(result.importPath).toBe('booking.service');
    expect(result.totalFound).toBe(2);
    expect(result.dependentFiles[0].filePath).toBe('src/booking/booking.controller.ts');
    expect(result.dependentFiles[0].nestRole).toBe('controller');
    expect(result.dependentFiles[0].matchedImports).toHaveLength(1);
    expect(result.dependentFiles[0].matchedImports[0].source).toBe('./booking.service');
  });

  it('should return empty results when findByImport returns []', async () => {
    (searchService.findByImport as jest.Mock).mockResolvedValue([]);
    const result = await tool.execute({ importPath: 'nonexistent' });
    expect(result.totalFound).toBe(0);
    expect(result.dependentFiles).toHaveLength(0);
  });
});
