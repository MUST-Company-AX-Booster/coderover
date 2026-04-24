import { Injectable } from '@nestjs/common';
import { SearchService } from '../../search/search.service';
import { ImportInfo } from '../../ingest/ast.service';
import { MCPTool, MCPToolParameter } from './index';

@Injectable()
export class FindDependenciesTool implements MCPTool {
  readonly name = 'find_dependencies';
  readonly description =
    'Find all files that import a given module, service, or path. Use to understand the dependency graph — e.g. "which files depend on BookingService?".';
  readonly parameters: MCPToolParameter[] = [
    {
      name: 'importPath',
      type: 'string',
      description:
        'Module path or partial name to search for (e.g. "booking.service", "@nestjs/common", "stripe")',
      required: true,
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
    const importPath = args.importPath as string;
    const repoId = args.repoId as string | undefined;

    const results = await this.searchService.findByImport(importPath, { repoId });

    const fileMap = new Map<
      string,
      { filePath: string; nestRole: string | null; matchedImports: ImportInfo[] }
    >();

    for (const r of results) {
      if (!fileMap.has(r.filePath)) {
        const matchedImports = (r.imports ?? []).filter(
          (imp) => imp.source.includes(importPath) || imp.source === importPath,
        );
        fileMap.set(r.filePath, {
          filePath: r.filePath,
          nestRole: r.nestRole,
          matchedImports,
        });
      }
    }

    return {
      importPath,
      dependentFiles: [...fileMap.values()],
      totalFound: fileMap.size,
    };
  }
}
