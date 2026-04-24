import { Injectable } from '@nestjs/common';
import { SearchService } from '../../search/search.service';
import { MCPTool, MCPToolParameter } from './index';

interface EndpointInfo {
  method: string;
  path: string;
  handler: string;
  file: string;
}

@Injectable()
export class GetApiEndpointsTool implements MCPTool {
  readonly name = 'get_api_endpoints';
  readonly description =
    'Extract all REST API endpoints defined in a module controller. Returns route methods, paths, and handler names.';
  readonly parameters: MCPToolParameter[] = [
    { name: 'moduleName', type: 'string', description: 'e.g. "BookingModule"', required: true },
    { name: 'repoId', type: 'string', description: 'Filter by repository UUID', required: false },
  ];

  constructor(private readonly searchService: SearchService) {}

  /** Search for controller chunks and extract HTTP endpoint decorators */
  async execute(args: Record<string, any>): Promise<any> {
    const moduleName = args.moduleName as string;

    const repoId = args.repoId as string | undefined;

    const results = await this.searchService.search(
      `${moduleName} controller routes endpoints`,
      { topK: 10, moduleFilter: moduleName, repoId },
    );

    const endpoints: EndpointInfo[] = [];
    const decoratorPattern = /@(Get|Post|Put|Patch|Delete)\(['"]?([^'")\s]*)['"]?\)/g;
    const handlerPattern = /(?:async\s+)?(\w+)\s*\(/;

    for (const chunk of results) {
      const lines = chunk.chunkText.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const match = decoratorPattern.exec(lines[i]);
        if (match) {
          const method = match[1].toUpperCase();
          const path = match[2] || '/';

          // Look at next non-empty line for handler name
          let handler = 'unknown';
          for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
            const trimmed = lines[j].trim();
            if (trimmed) {
              const hMatch = handlerPattern.exec(trimmed);
              if (hMatch) {
                handler = hMatch[1];
              }
              break;
            }
          }

          endpoints.push({
            method,
            path: path.startsWith('/') ? path : `/${path}`,
            handler,
            file: chunk.filePath,
          });
        }
        // Reset regex lastIndex since we use global flag
        decoratorPattern.lastIndex = 0;
      }
    }

    return {
      moduleName,
      endpoints,
    };
  }
}
