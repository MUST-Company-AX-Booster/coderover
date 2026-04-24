import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MemgraphService } from '../../graph/memgraph.service';
import { GraphService } from '../../graph/graph.service';
import { MCPTool, MCPToolParameter } from './index';
import OpenAI from 'openai';
import {
  createLocalChatCompletion,
  resolveLlmBaseUrl,
  resolveLlmProvider,
} from '../../config/openai.config';

@Injectable()
export class QueryCodeGraphTool implements MCPTool {
  readonly name = 'query_code_graph';
  readonly description =
    'Query the codebase knowledge graph using natural language. Use this to ask complex questions about architectural relationships, dependencies, and code structure (e.g., "What services depend on AuthService?", "Show me the inheritance hierarchy of BaseEntity").';
  
  readonly parameters: MCPToolParameter[] = [
    {
      name: 'repoId',
      type: 'string',
      description: 'Repository UUID',
      required: true,
    },
    {
      name: 'query',
      type: 'string',
      description: 'Natural language query about the code graph',
      required: true,
    },
  ];

  private readonly openai: OpenAI;
  private readonly logger = new Logger(QueryCodeGraphTool.name);
  private readonly llmProvider: 'openai' | 'openrouter' | 'local';

  constructor(
    private readonly memgraphService: MemgraphService,
    private readonly graphService: GraphService,
    private readonly configService: ConfigService,
  ) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    const configuredBaseURL = this.configService.get<string>('OPENAI_BASE_URL');
    this.llmProvider = resolveLlmProvider(
      this.configService.get<string>('LLM_PROVIDER'),
      apiKey,
      configuredBaseURL,
    );
    const baseURL = resolveLlmBaseUrl(this.llmProvider, configuredBaseURL, apiKey, 'chat');
    
    this.openai = new OpenAI({
      apiKey: apiKey || 'dummy', // Prevent crash if key missing, but tool will fail
      baseURL: baseURL || undefined,
    });
  }

  async execute(args: Record<string, any>): Promise<any> {
    const repoId = args.repoId as string;
    const query = args.query as string;

    if (!repoId || !query) {
      throw new Error('repoId and query are required');
    }

    const dependencyQueryResult = await this.tryHandleFileDependencyQuery(repoId, query);
    if (dependencyQueryResult) {
      return dependencyQueryResult;
    }

    // 1. Generate Cypher query using LLM
    const cypher = await this.generateCypher(query);
    this.logger.log(`Generated Cypher: ${cypher}`);

    // 2. Execute Cypher
    try {
      const records = await this.memgraphService.readQuery(cypher, { repoId });
      
      // 3. Format results
      return {
        query: query,
        generatedCypher: cypher,
        results: records.map(r => r.toObject()),
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Cypher execution failed: ${errorMsg}`);
      return {
        error: `Failed to execute graph query: ${errorMsg}`,
        generatedCypher: cypher,
      };
    }
  }

  private async generateCypher(userQuery: string): Promise<string> {
    const schema = `
      Nodes:
      - (:File {repoId, filePath, moduleName, nestRole})
      - (:Symbol {repoId, name, kind, filePath})
      - (:Class {repoId, name, filePath})
      - (:Method {repoId, name, className, filePath, args})
      - (:Function {repoId, name, filePath})
      
      Edges:
      - (:File)-[:IMPORTS]->(:File)
      - (:File)-[:DEFINES]->(:Symbol)
      - (:File)-[:DEFINES]->(:Class)
      - (:Class)-[:DEFINES]->(:Method)
      - (:Class)-[:INHERITS]->(:Class)
      - (Method or Function)-[:CALLS]->(Method, Function, or Class)
      
      Note: 'repoId' property is present on all nodes. Always filter by $repoId parameter.
    `;

    const prompt = `
      You are an expert Cypher query generator for Memgraph/Neo4j.
      Translate the following natural language query into a Cypher query.
      
      Schema:
      ${schema}
      
      User Query: "${userQuery}"
      
      Rules:
      1. ALWAYS filter by the parameter $repoId (e.g., n.repoId = $repoId).
      2. Return ONLY the Cypher query string, no markdown, no explanations.
      3. Use case-insensitive matching for names if needed (e.g., toLower(n.name) CONTAINS toLower('...')).
      3a. File paths are usually full relative paths like "backend/src/store/appStore.ts", not bare basenames. If the user mentions "appStore.ts", do NOT use exact equality on filePath with "appStore.ts". Instead, match with toLower(filePath) ENDS WITH '/appstore.ts' OR toLower(filePath) = 'appstore.ts'.
      4. Limit results to 50 if not specified.
      5. Return useful properties (filePath, name, kind).
      6. IMPORTANT: Memgraph does NOT support label disjunctions in node patterns (e.g., (:Method|:Function) is INVALID). Instead, omit the label and use the labels() function in the WHERE clause, e.g., MATCH (n) WHERE 'Method' IN labels(n) OR 'Function' IN labels(n).
      7. IMPORTANT: Memgraph does NOT support the EXISTS() function inside CASE statements or WITH clauses. Only use EXISTS() inside WHERE clauses. For conditional logic, use OPTIONAL MATCH and check if the relationship IS NOT NULL.
      
      Example 1: "What functions call authenticate_user?"
      MATCH (caller)-[:CALLS]->(callee {repoId: $repoId, name: 'authenticate_user'})
      WHERE caller.repoId = $repoId
      RETURN caller.name, caller.filePath, labels(caller)
      
      Example 2: "Show class inheritance for BaseEntity"
      MATCH (c:Class {repoId: $repoId, name: 'BaseEntity'})<-[:INHERITS*]-(sub:Class)
      RETURN sub.name, sub.filePath
    `;

    const response = this.llmProvider === 'local'
      ? await createLocalChatCompletion({
          apiKey: this.configService.get<string>('OPENAI_API_KEY'),
          baseUrl: this.configService.get<string>('OPENAI_BASE_URL'),
          model: this.configService.get<string>('OPENAI_CHAT_MODEL') || 'gpt-4o',
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: userQuery },
          ],
          temperature: 0,
        })
      : await this.openai.chat.completions.create({
          model: this.configService.get<string>('OPENAI_CHAT_MODEL') || 'gpt-4o',
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: userQuery },
          ],
          temperature: 0,
        });

    let cypher = response.choices[0]?.message?.content?.trim() || '';
    // Strip markdown code blocks if present
    cypher = cypher.replace(/^```cypher\s*/, '').replace(/^```\s*/, '').replace(/```$/, '');
    return cypher;
  }

  private async tryHandleFileDependencyQuery(repoId: string, userQuery: string): Promise<any | null> {
    const targetFileName = this.extractTargetFileName(userQuery);
    if (!targetFileName) {
      return null;
    }

    const normalizedQuery = userQuery.toLowerCase();
    const isDependencyQuery =
      normalizedQuery.includes('depend on') ||
      normalizedQuery.includes('depends on') ||
      normalizedQuery.includes('import') ||
      normalizedQuery.includes('use from');

    if (!isDependencyQuery) {
      return null;
    }

    const graph = await this.graphService.buildGraph(repoId);
    const allNodes = Object.values(graph.nodes);
    const targetFile = this.findBestMatchingFilePath(allNodes.map((node) => node.filePath), targetFileName);

    if (!targetFile) {
      return null;
    }

    const allFilePaths = allNodes.map((node) => node.filePath);
    const dependentFiles = allNodes
      .filter((node) => node.dependencies.includes(targetFile))
      .map((node) => {
        const matchedImports = node.imports.filter(
          (imp) => this.graphService.resolveImportPath(node.filePath, imp.source, allFilePaths) === targetFile,
        );
        const usedSymbols = [...new Set(matchedImports.flatMap((imp) => imp.names).filter(Boolean))];
        const stateNames = usedSymbols.filter((name) => name.toLowerCase().includes('state'));

        return {
          filePath: node.filePath,
          moduleName: node.moduleName,
          stateNames: stateNames.length > 0 ? stateNames : usedSymbols,
          usedSymbols,
          kind: 'File',
        };
      });

    return {
      query: userQuery,
      generatedCypher: [
        `MATCH (importer:File {repoId: $repoId})-[:IMPORTS]->(target:File {repoId: $repoId, filePath: '${targetFile}'})`,
        `RETURN importer.filePath AS filePath, importer.moduleName AS moduleName, 'File' AS kind`,
        `LIMIT 50`,
      ].join('\n'),
      resolvedTargetFile: targetFile,
      results: dependentFiles,
    };
  }

  private extractTargetFileName(userQuery: string): string | null {
    const match = userQuery.match(/([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|py|go|java|kt|php|rs))/i);
    return match?.[1] ?? null;
  }

  private findBestMatchingFilePath(filePaths: string[], requestedFileName: string): string | null {
    const normalizedRequested = requestedFileName.toLowerCase();
    const suffix = `/${normalizedRequested}`;

    const candidates = filePaths.filter((filePath) => {
      const normalizedPath = filePath.toLowerCase();
      return normalizedPath === normalizedRequested || normalizedPath.endsWith(suffix);
    });

    if (candidates.length === 0) {
      return null;
    }

    return candidates.sort((left, right) => left.length - right.length)[0];
  }
}
