import { Injectable } from '@nestjs/common';
import { SearchService } from '../../search/search.service';
import { ArtifactsService } from '../../artifacts/artifacts.service';
import { MCPTool, MCPToolParameter } from './index';

@Injectable()
export class SearchCodebaseTool implements MCPTool {
  readonly name = 'search_codebase';
  readonly description =
    'Semantically search the indexed codebase for relevant code, services, or logic. ' +
    'Supports hybrid BM25+semantic search. Use language/framework filters to narrow by ecosystem.';
  readonly parameters: MCPToolParameter[] = [
    { name: 'query', type: 'string', description: 'Natural language or identifier query', required: true },
    { name: 'topK', type: 'number', description: 'Number of results (1-20, default 8)', required: false },
    { name: 'moduleFilter', type: 'string', description: 'Filter by module name (e.g. "BookingModule")', required: false },
    { name: 'repoId', type: 'string', description: 'Filter by repository UUID', required: false },
    { name: 'repoIds', type: 'string', description: 'Comma-separated repository UUIDs for cross-repo search', required: false },
    { name: 'language', type: 'string', description: 'Filter by language: typescript, python, go, java, kotlin, rust, php, vue', required: false },
    { name: 'framework', type: 'string', description: 'Filter by framework: nestjs, nextjs, vite-react, vite-vue, angular, svelte, fastapi, django', required: false },
    { name: 'searchMode', type: 'string', description: 'Search mode: hybrid (default), semantic, keyword', required: false },
    { name: 'includeArtifacts', type: 'boolean', description: 'Also search context artifacts (schemas, OpenAPI, Terraform)', required: false },
  ];

  constructor(
    private readonly searchService: SearchService,
    private readonly artifactsService: ArtifactsService,
  ) {}

  async execute(args: Record<string, any>): Promise<any> {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query.trim()) {
      return { results: [], totalFound: 0, error: 'Missing required parameter "query"' };
    }

    const topK = args.topK ? Math.min(Math.max(Number(args.topK), 1), 20) : 8;
    const moduleFilter = args.moduleFilter as string | undefined;
    const repoId = args.repoId as string | undefined;
    const repoIds = args.repoIds
      ? (args.repoIds as string).split(',').map((s: string) => s.trim())
      : undefined;
    const language = args.language as string | undefined;
    const framework = args.framework as string | undefined;
    const searchMode = (args.searchMode as 'hybrid' | 'semantic' | 'keyword') || 'auto';
    const includeArtifacts = args.includeArtifacts === true || args.includeArtifacts === 'true';

    const results = await this.searchService.search(query, {
      topK, moduleFilter, repoId, repoIds, language, framework, searchMode,
    });

    const output: any = {
      results: results.map((r) => ({
        filePath: r.filePath,
        moduleName: r.moduleName,
        lines: `${r.lineStart}-${r.lineEnd}`,
        similarity: Math.round(r.similarity * 100) / 100,
        language: r.language ?? null,
        framework: r.framework ?? null,
        nestRole: r.nestRole ?? null,
        preview: r.chunkText.substring(0, 200),
      })),
      totalFound: results.length,
    };

    if (includeArtifacts) {
      const artifactResults = await this.artifactsService.searchArtifacts(query, { repoId, topK: 3 });
      output.artifacts = artifactResults.map((a) => ({
        filePath: a.filePath,
        type: a.artifactType,
        similarity: Math.round(a.similarity * 100) / 100,
        preview: a.content.substring(0, 300),
      }));
    }

    return output;
  }
}
