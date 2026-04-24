import { Injectable } from '@nestjs/common';
import { SearchService } from '../../search/search.service';
import { MCPTool, MCPToolParameter } from './index';

@Injectable()
export class FindSymbolTool implements MCPTool {
  readonly name = 'find_symbol';
  readonly description =
    'Find code chunks that define a specific symbol (class, function, interface, enum) by name. Use this to locate where a class or function is defined across any indexed repo.';
  readonly parameters: MCPToolParameter[] = [
    {
      name: 'symbolName',
      type: 'string',
      description: 'Exact symbol name to find (e.g. "BookingService", "CreateBookingDto")',
      required: true,
    },
    {
      name: 'kind',
      type: 'string',
      description: 'Symbol kind filter: class | function | interface | enum | type | const',
      required: false,
    },
    {
      name: 'repoId',
      type: 'string',
      description: 'Scope to a specific repo UUID',
      required: false,
    },
  ];

  constructor(private readonly searchService: SearchService) {}

  async execute(args: Record<string, any>): Promise<any> {
    const symbolName = args.symbolName as string;
    const kind = args.kind as string | undefined;
    const repoId = args.repoId as string | undefined;

    const results = await this.searchService.findSymbol(symbolName, { repoId, kind });

    return {
      symbolName,
      kind: kind ?? 'any',
      results: results.map((r) => ({
        filePath: r.filePath,
        moduleName: r.moduleName,
        nestRole: r.nestRole,
        lines: `${r.lineStart}-${r.lineEnd}`,
        symbols: r.symbols?.filter((s) => s.name === symbolName) ?? [],
        preview: r.chunkText.substring(0, 300),
      })),
      totalFound: results.length,
    };
  }
}
