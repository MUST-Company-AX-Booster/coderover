import { Injectable } from '@nestjs/common';
import { SearchService, SearchResult } from '../../search/search.service';
import { MCPTool, MCPToolParameter } from './index';

@Injectable()
export class GenerateCodeTool implements MCPTool {
  readonly name = 'generate_code';
  readonly description =
    'Generate production-ready NestJS/TypeScript code following the exact patterns and conventions of the codebase.';
  readonly parameters: MCPToolParameter[] = [
    { name: 'prompt', type: 'string', description: 'What code to generate', required: true },
    { name: 'contextQuery', type: 'string', description: 'Additional search query to retrieve related patterns', required: false },
    { name: 'repoId', type: 'string', description: 'Target repository UUID for code generation context', required: false },
  ];

  constructor(private readonly searchService: SearchService) {}

  /** Retrieve codebase context for code generation (actual generation done by LLM) */
  async execute(args: Record<string, any>): Promise<any> {
    const prompt = args.prompt as string;
    const contextQuery = args.contextQuery as string | undefined;
    const repoId = args.repoId as string | undefined;

    const primaryResults = await this.searchService.search(prompt, { topK: 5, repoId });

    const allResults: SearchResult[] = [...primaryResults];

    if (contextQuery) {
      const contextResults = await this.searchService.search(contextQuery, { topK: 5, repoId });
      // Deduplicate by filePath + lineStart
      const seen = new Set(primaryResults.map((r) => `${r.filePath}:${r.lineStart}`));
      for (const r of contextResults) {
        const key = `${r.filePath}:${r.lineStart}`;
        if (!seen.has(key)) {
          allResults.push(r);
          seen.add(key);
        }
      }
    }

    return {
      prompt,
      contextFiles: allResults.map((r) => r.filePath),
      contextReady: true,
      instruction:
        'Use the retrieved context to generate code. Follow exact patterns from the codebase.',
    };
  }
}
