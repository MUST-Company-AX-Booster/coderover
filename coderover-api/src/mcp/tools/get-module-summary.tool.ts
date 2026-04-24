import { Injectable } from '@nestjs/common';
import { SearchService } from '../../search/search.service';
import { MCPTool, MCPToolParameter } from './index';

@Injectable()
export class GetModuleSummaryTool implements MCPTool {
  readonly name = 'get_module_summary';
  readonly description =
    'Get a structured summary of all code chunks in a specific module. Use to understand what a module does before diving into details.';
  readonly parameters: MCPToolParameter[] = [
    { name: 'moduleName', type: 'string', description: 'e.g. "BookingModule", "WalletModule"', required: true },
    { name: 'repoId', type: 'string', description: 'Filter by repository UUID', required: false },
  ];

  constructor(private readonly searchService: SearchService) {}

  /** Retrieve a summary of all chunks in the given module */
  async execute(args: Record<string, any>): Promise<any> {
    const moduleName = args.moduleName as string;
    const repoId = args.repoId as string | undefined;
    const results = await this.searchService.searchByModule(moduleName, 30, repoId);

    const distinctFiles = new Set(results.map((r) => r.filePath));

    const files = [...distinctFiles].map((fp) => {
      const chunks = results.filter((r) => r.filePath === fp);
      const minLine = Math.min(...chunks.map((c) => c.lineStart));
      const maxLine = Math.max(...chunks.map((c) => c.lineEnd));
      return {
        filePath: fp,
        lineCount: maxLine - minLine,
        preview: chunks[0]?.chunkText.substring(0, 100) ?? '',
      };
    });

    return {
      moduleName,
      fileCount: distinctFiles.size,
      totalChunks: results.length,
      files,
    };
  }
}
