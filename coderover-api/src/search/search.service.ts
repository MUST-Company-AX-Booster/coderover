import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import OpenAI from 'openai';
import { SymbolInfo, ImportInfo } from '../ingest/ast.service';
import { createLocalEmbeddings, resolveLlmBaseUrl, resolveLlmProvider } from '../config/openai.config';

export interface SearchResult {
  id: string;
  filePath: string;
  moduleName: string | null;
  chunkText: string;
  lineStart: number;
  lineEnd: number;
  similarity: number;
  symbols: SymbolInfo[] | null;
  nestRole: string | null;
  imports: ImportInfo[] | null;
  language: string | null;
  framework: string | null;
}

export interface SearchOptions {
  topK?: number;
  minSimilarity?: number;
  moduleFilter?: string;
  repoId?: string;
  repoIds?: string[];
  nestRole?: string;
  symbolName?: string;
  language?: string;
  framework?: string;
  /** Use hybrid BM25+semantic mode. Defaults to 'auto' */
  searchMode?: 'semantic' | 'keyword' | 'hybrid' | 'auto';
}

export interface RetrievalDebugResponse {
  mode: 'semantic' | 'keyword' | 'hybrid';
  fallbackUsed: boolean;
  queryTokens: string[];
  results: SearchResult[];
  error?: string;
}

/** Hybrid search weights */
const SEMANTIC_WEIGHT = 0.7;
const BM25_WEIGHT = 0.3;

/** Max entries in the query embedding cache (LRU) */
const CACHE_MAX_SIZE = 50;

export class SearchEmbeddingDimensionMismatchError extends Error {
  readonly expectedDimensions: number;
  readonly actualDimensions: number;

  constructor(expectedDimensions: number, actualDimensions: number) {
    super(`Expected ${expectedDimensions} dimensions, not ${actualDimensions}`);
    this.expectedDimensions = expectedDimensions;
    this.actualDimensions = actualDimensions;
  }
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  private readonly openai: OpenAI;
  private readonly embeddingCache = new Map<string, number[]>();
  private readonly embeddingModel: string;
  private readonly embeddingDimensions: number;
  private resolvedEmbeddingDimensions: number | undefined;
  private readonly llmProvider: 'openai' | 'openrouter' | 'local';

  constructor(
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    const configuredBaseURL = this.configService.get<string>('OPENAI_BASE_URL');
    this.llmProvider = resolveLlmProvider(
      this.configService.get<string>('LLM_PROVIDER'),
      apiKey,
      configuredBaseURL,
    );
    const baseURL = resolveLlmBaseUrl(this.llmProvider, configuredBaseURL, apiKey, 'embeddings');

    this.openai = new OpenAI({ apiKey, baseURL });

    const defaultEmbeddingModel = apiKey?.startsWith('sk-or-')
      ? 'openai/text-embedding-3-large'
      : 'text-embedding-3-large';

    this.embeddingModel =
      this.configService.get<string>('OPENAI_EMBEDDING_MODEL') || defaultEmbeddingModel;

    const configuredDimensions = Number(this.configService.get('OPENAI_EMBEDDING_DIMENSIONS'));
    this.embeddingDimensions =
      Number.isFinite(configuredDimensions) && configuredDimensions > 0
        ? configuredDimensions
        : 1536;

  }

  private async resolveEmbeddingDimensions(): Promise<number> {
    if (this.resolvedEmbeddingDimensions) return this.resolvedEmbeddingDimensions;
    try {
      const result = await this.dataSource.query(
        `
        SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) AS formatted
        FROM pg_attribute a
        JOIN pg_class c ON a.attrelid = c.oid
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE n.nspname = 'public' AND c.relname = 'code_chunks'
          AND a.attname = 'embedding' AND a.attisdropped = false
        LIMIT 1
        `,
      );
      const formatted = String(result?.[0]?.formatted ?? '');
      const match = formatted.match(/vector\((\d+)\)/);
      if (match) {
        this.resolvedEmbeddingDimensions = Number(match[1]);
        return this.resolvedEmbeddingDimensions;
      }
    } catch {
      // ignore
    }
    this.resolvedEmbeddingDimensions = this.embeddingDimensions;
    return this.embeddingDimensions;
  }

  /**
   * Embed a query string. Results are cached in an in-memory LRU Map.
   */
  async embedQuery(query: string): Promise<number[]> {
    if (typeof query !== 'string' || !query.trim()) {
      throw new Error('Query must be a non-empty string');
    }
    const cached = this.embeddingCache.get(query);
    if (cached) return cached;

    const expectedDimensions = await this.resolveEmbeddingDimensions();
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    const response = this.llmProvider === 'local'
      ? await createLocalEmbeddings({
          apiKey,
          baseUrl: this.configService.get<string>('OPENAI_BASE_URL'),
          model: this.embeddingModel,
          input: query,
        })
      : await this.openai.embeddings.create({
          model: this.embeddingModel,
          input: query,
          dimensions: expectedDimensions,
        });

    const embedding = response.data[0].embedding;
    if (embedding.length !== expectedDimensions) {
      throw new SearchEmbeddingDimensionMismatchError(expectedDimensions, embedding.length);
    }

    if (this.embeddingCache.size >= CACHE_MAX_SIZE) {
      const oldestKey = this.embeddingCache.keys().next().value!;
      this.embeddingCache.delete(oldestKey);
    }
    this.embeddingCache.set(query, embedding);
    return embedding;
  }

  private buildRepoFilter(
    options: { repoId?: string; repoIds?: string[] } | undefined,
    paramOffset: number,
  ): { clause: string; params: any[] } {
    if (!options) return { clause: '', params: [] };
    if (options.repoIds && options.repoIds.length > 0) {
      return {
        clause: ` AND (repo_id = ANY($${paramOffset}::uuid[]) OR repo_id IS NULL)`,
        params: [options.repoIds],
      };
    }
    if (options.repoId) {
      return { clause: ` AND repo_id = $${paramOffset}`, params: [options.repoId] };
    }
    return { clause: '', params: [] };
  }

  private buildExtraFilters(
    options: SearchOptions | undefined,
    paramOffset: number,
  ): { clauses: string; params: any[]; finalParamIdx: number } {
    const params: any[] = [];
    const clauses: string[] = [];
    let idx = paramOffset;

    if (options?.nestRole) {
      clauses.push(` AND nest_role = $${idx}`);
      params.push(options.nestRole);
      idx++;
    }
    if (options?.language) {
      clauses.push(` AND language = $${idx}`);
      params.push(options.language);
      idx++;
    }
    if (options?.framework) {
      clauses.push(` AND framework = $${idx}`);
      params.push(options.framework);
      idx++;
    }
    if (options?.symbolName) {
      clauses.push(` AND symbols IS NOT NULL AND symbols @> $${idx}::jsonb`);
      params.push(JSON.stringify([{ name: options.symbolName }]));
      idx++;
    }

    return { clauses: clauses.join(''), params, finalParamIdx: idx };
  }

  private resolveSearchMode(query: string, options?: SearchOptions): 'semantic' | 'keyword' | 'hybrid' {
    const requested = options?.searchMode ?? 'auto';
    if (requested !== 'auto') return requested as 'semantic' | 'keyword' | 'hybrid';

    // Auto: hybrid for natural language, keyword-boosted hybrid for exact identifiers
    // If query looks like a camelCase/PascalCase identifier, use hybrid
    if (/^[A-Z][a-zA-Z0-9]+$/.test(query) || /[A-Z]{2,}/.test(query)) return 'hybrid';
    // Short single-word queries get hybrid
    if (query.split(' ').length <= 2) return 'hybrid';
    return 'hybrid';
  }

  private extractSearchTokens(query: string): string[] {
    const normalized = query
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[^a-zA-Z0-9_./-]+/g, ' ')
      .toLowerCase();

    const stopwords = new Set([
      'the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'with',
      'how', 'what', 'where', 'when', 'why', 'which', 'show', 'find', 'list',
      'get', 'give', 'all', 'from', 'into', 'that', 'this', 'these', 'those',
      'does', 'do', 'is', 'are', 'be', 'about', 'please',
    ]);

    return Array.from(
      new Set(
        normalized
          .split(/\s+/)
          .map((t) => t.trim())
          .filter((t) => t.length >= 3 && !stopwords.has(t)),
      ),
    ).slice(0, 6);
  }

  private async expandedKeywordSearch(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const topK = options?.topK ?? 8;
    const direct = await this.keywordSearch(query, options);
    if (direct.length >= topK) return direct;

    const tokens = this.extractSearchTokens(query);
    if (tokens.length === 0) return direct;

    const merged = new Map<string, SearchResult>();
    for (const row of direct) merged.set(row.id, row);

    for (const token of tokens) {
      const tokenRows = await this.keywordSearch(token, { ...options, topK: Math.max(topK, 12) });
      for (const row of tokenRows) {
        const existing = merged.get(row.id);
        if (!existing || row.similarity > existing.similarity) {
          merged.set(row.id, row);
        }
      }
      if (merged.size >= topK * 3) break;
    }

    return [...merged.values()]
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  /**
   * Main search entry point.
   * Automatically selects hybrid/semantic/keyword mode based on provider and query.
   */
  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    if (typeof query !== 'string' || !query.trim()) return [];

    const mode = this.resolveSearchMode(query, options);

    if (mode === 'keyword') {
      return this.expandedKeywordSearch(query, options);
    }

    try {
      const semanticRows =
        mode === 'hybrid'
          ? await this.hybridSearch(query, options)
          : await this.semanticSearch(query, options);

      if (semanticRows.length > 0) return semanticRows;

      this.logger.debug(`${mode} search returned 0 rows for "${query.substring(0, 40)}"; trying keyword fallback`);
      return this.expandedKeywordSearch(query, options);
    } catch (err) {
      this.logger.warn(
        `${mode} search failed (${err instanceof Error ? err.message : String(err)}). Falling back to keyword search.`,
      );
      return this.expandedKeywordSearch(query, options);
    }
  }

  async debugRetrieval(query: string, options?: SearchOptions): Promise<RetrievalDebugResponse> {
    const mode = this.resolveSearchMode(query, options);
    const queryTokens = this.extractSearchTokens(query);

    if (mode === 'keyword') {
      const rows = await this.expandedKeywordSearch(query, options);
      return { mode, fallbackUsed: false, queryTokens, results: rows };
    }

    try {
      const semanticRows =
        mode === 'hybrid'
          ? await this.hybridSearch(query, options)
          : await this.semanticSearch(query, options);

      if (semanticRows.length > 0) {
        return { mode, fallbackUsed: false, queryTokens, results: semanticRows };
      }

      const fallbackRows = await this.expandedKeywordSearch(query, options);
      return { mode, fallbackUsed: true, queryTokens, results: fallbackRows };
    } catch (err) {
      const fallbackRows = await this.expandedKeywordSearch(query, options);
      return {
        mode,
        fallbackUsed: true,
        queryTokens,
        results: fallbackRows,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Hybrid search: 0.7 × semantic + 0.3 × BM25 in a single SQL query.
   * camelCase identifiers are split before BM25 so "PaymentService" matches "Payment Service".
   */
  private async hybridSearch(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const topK = options?.topK ?? 8;
    const minSimilarity = options?.minSimilarity ?? 0.0;
    const moduleFilter = options?.moduleFilter;

    const embedding = await this.embedQuery(query);
    const vectorStr = `[${embedding.join(',')}]`;

    // $1=vector, $2=query, $3=minSimilarity, $4=topK
    const baseParams: any[] = [vectorStr, query, minSimilarity, topK];
    let paramIdx = 5;

    let moduleClause = '';
    if (moduleFilter) {
      moduleClause = ` AND module_name = $${paramIdx}`;
      baseParams.push(moduleFilter);
      paramIdx++;
    }

    const repoFilter = this.buildRepoFilter(options, paramIdx);
    if (repoFilter.params.length > 0) {
      paramIdx += repoFilter.params.length;
      baseParams.push(...repoFilter.params);
    }

    const extraFilters = this.buildExtraFilters(options, paramIdx);

    const sql = `
      SELECT
        id,
        file_path     AS "filePath",
        module_name   AS "moduleName",
        chunk_text    AS "chunkText",
        line_start    AS "lineStart",
        line_end      AS "lineEnd",
        nest_role     AS "nestRole",
        symbols       AS "symbols",
        language      AS "language",
        framework     AS "framework",
        (
          ${SEMANTIC_WEIGHT} * (1 - (embedding <=> $1::vector))
          + ${BM25_WEIGHT} * ts_rank_cd(
              chunk_tsv,
              plainto_tsquery(
                'english',
                regexp_replace($2, '([a-z0-9])([A-Z])', '\\1 \\2', 'g')
              )
            )
        ) AS similarity
      FROM code_chunks
      WHERE embedding IS NOT NULL
        AND chunk_tsv IS NOT NULL
        AND (
          1 - (embedding <=> $1::vector) >= $3
          OR chunk_tsv @@ plainto_tsquery(
               'english',
               regexp_replace($2, '([a-z0-9])([A-Z])', '\\1 \\2', 'g')
             )
        )
        ${moduleClause}${repoFilter.clause}${extraFilters.clauses}
      ORDER BY similarity DESC
      LIMIT $4
    `;

    const params = [...baseParams, ...extraFilters.params];
    const rows: SearchResult[] = await this.dataSource.query(sql, params);
    this.logger.debug(`Hybrid search for "${query.substring(0, 40)}" returned ${rows.length} results`);
    return rows;
  }

  private async semanticSearch(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const topK = options?.topK ?? 8;
    const minSimilarity = options?.minSimilarity ?? 0.3;
    const moduleFilter = options?.moduleFilter;

    const embedding = await this.embedQuery(query);
    const vectorStr = `[${embedding.join(',')}]`;

    // $1=vector, $2=minSimilarity, $3=topK
    const baseParams: any[] = [vectorStr, minSimilarity, topK];
    let paramIdx = 4;

    let moduleClause = '';
    if (moduleFilter) {
      moduleClause = ` AND module_name = $${paramIdx}`;
      baseParams.push(moduleFilter);
      paramIdx++;
    }

    const repoFilter = this.buildRepoFilter(options, paramIdx);
    if (repoFilter.params.length > 0) {
      paramIdx += repoFilter.params.length;
      baseParams.push(...repoFilter.params);
    }

    const extraFilters = this.buildExtraFilters(options, paramIdx);

    const sql = `
      SELECT
        id,
        file_path     AS "filePath",
        module_name   AS "moduleName",
        chunk_text    AS "chunkText",
        line_start    AS "lineStart",
        line_end      AS "lineEnd",
        nest_role     AS "nestRole",
        symbols       AS "symbols",
        language      AS "language",
        framework     AS "framework",
        1 - (embedding <=> $1::vector) AS similarity
      FROM code_chunks
      WHERE embedding IS NOT NULL
        AND 1 - (embedding <=> $1::vector) >= $2
        ${moduleClause}${repoFilter.clause}${extraFilters.clauses}
      ORDER BY embedding <=> $1::vector
      LIMIT $3
    `;

    const params = [...baseParams, ...extraFilters.params];
    const rows: SearchResult[] = await this.dataSource.query(sql, params);
    this.logger.debug(`Semantic search for "${query.substring(0, 40)}" returned ${rows.length} results`);
    return rows;
  }

  private async keywordSearch(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    if (typeof query !== 'string' || !query.trim()) return [];
    const topK = options?.topK ?? 8;
    const moduleFilter = options?.moduleFilter;

    const baseParams: any[] = [query, topK];
    let paramIdx = 3;

    let moduleClause = '';
    if (moduleFilter) {
      moduleClause = ` AND module_name = $${paramIdx}`;
      baseParams.push(moduleFilter);
      paramIdx++;
    }

    const repoFilter = this.buildRepoFilter(options, paramIdx);
    if (repoFilter.params.length > 0) {
      paramIdx += repoFilter.params.length;
      baseParams.push(...repoFilter.params);
    }

    const extraFilters = this.buildExtraFilters(options, paramIdx);

    const normalizedExpr = `regexp_replace(chunk_text, '([a-z0-9])([A-Z])', '\\\\1 \\\\2', 'g')`;

    const sql = `
      SELECT
        id,
        file_path     AS "filePath",
        module_name   AS "moduleName",
        chunk_text    AS "chunkText",
        line_start    AS "lineStart",
        line_end      AS "lineEnd",
        nest_role     AS "nestRole",
        symbols       AS "symbols",
        language      AS "language",
        framework     AS "framework",
        ts_rank(to_tsvector('simple', ${normalizedExpr}), plainto_tsquery('simple', $1)) AS similarity
      FROM code_chunks
      WHERE (
        to_tsvector('simple', ${normalizedExpr}) @@ plainto_tsquery('simple', $1)
        OR ${normalizedExpr} ILIKE ('%' || $1 || '%')
        OR chunk_text ILIKE ('%' || replace($1, ' ', '') || '%')
      )
        ${moduleClause}${repoFilter.clause}${extraFilters.clauses}
      ORDER BY similarity DESC
      LIMIT $2
    `;

    const params = [...baseParams, ...extraFilters.params];
    const rows: SearchResult[] = await this.dataSource.query(sql, params);
    this.logger.debug(`Keyword search for "${query.substring(0, 40)}" returned ${rows.length} results`);
    return rows;
  }

  async searchByModule(moduleName: string, topK = 30, repoId?: string): Promise<SearchResult[]> {
    const repoFilter = this.buildRepoFilter(repoId ? { repoId } : undefined, 3);

    const sql = `
      SELECT
        id,
        file_path   AS "filePath",
        module_name AS "moduleName",
        chunk_text  AS "chunkText",
        line_start  AS "lineStart",
        line_end    AS "lineEnd",
        nest_role   AS "nestRole",
        symbols     AS "symbols",
        language    AS "language",
        framework   AS "framework",
        1.0 AS similarity
      FROM code_chunks
      WHERE module_name = $1${repoFilter.clause}
      ORDER BY line_start
      LIMIT $2
    `;

    return this.dataSource.query(sql, [moduleName, topK, ...repoFilter.params]);
  }

  async getDistinctModules(repoId?: string): Promise<string[]> {
    if (repoId) {
      const rows: Array<{ module_name: string }> = await this.dataSource.query(
        `SELECT DISTINCT module_name FROM code_chunks WHERE module_name IS NOT NULL AND repo_id = $1 ORDER BY module_name`,
        [repoId],
      );
      return rows.map((r) => r.module_name);
    }
    const rows: Array<{ module_name: string }> = await this.dataSource.query(
      `SELECT DISTINCT module_name FROM code_chunks WHERE module_name IS NOT NULL ORDER BY module_name`,
    );
    return rows.map((r) => r.module_name);
  }

  async getFileChunks(filePath: string, repoId?: string): Promise<SearchResult[]> {
    const repoFilter = this.buildRepoFilter(repoId ? { repoId } : undefined, 2);
    const sql = `
      SELECT
        id,
        file_path   AS "filePath",
        module_name AS "moduleName",
        chunk_text  AS "chunkText",
        line_start  AS "lineStart",
        line_end    AS "lineEnd",
        nest_role   AS "nestRole",
        symbols     AS "symbols",
        language    AS "language",
        framework   AS "framework",
        1.0 AS similarity
      FROM code_chunks
      WHERE file_path = $1${repoFilter.clause}
      ORDER BY line_start
    `;
    return this.dataSource.query(sql, [filePath, ...repoFilter.params]);
  }

  async findSymbol(
    symbolName: string,
    options?: { repoId?: string; kind?: string },
  ): Promise<SearchResult[]> {
    const params: any[] = [];
    const searchObj: any = { name: symbolName };
    if (options?.kind) searchObj.kind = options.kind;
    params.push(JSON.stringify([searchObj]));

    let repoClause = '';
    if (options?.repoId) {
      repoClause = ` AND (repo_id = $2 OR repo_id IS NULL)`;
      params.push(options.repoId);
    }

    const sql = `
      SELECT
        id,
        file_path   AS "filePath",
        module_name AS "moduleName",
        chunk_text  AS "chunkText",
        line_start  AS "lineStart",
        line_end    AS "lineEnd",
        nest_role   AS "nestRole",
        symbols     AS "symbols",
        language    AS "language",
        framework   AS "framework",
        1.0 AS similarity
      FROM code_chunks
      WHERE symbols IS NOT NULL AND symbols @> $1::jsonb${repoClause}
      ORDER BY file_path, line_start
      LIMIT 20
    `;

    const rows: SearchResult[] = await this.dataSource.query(sql, params);
    this.logger.debug(`findSymbol "${symbolName}" returned ${rows.length} results`);
    return rows;
  }

  async findByImport(importSource: string, options?: { repoId?: string }): Promise<SearchResult[]> {
    const params: any[] = [`%${importSource}%`];
    let repoClause = '';
    if (options?.repoId) {
      repoClause = ` AND repo_id = $2`;
      params.push(options.repoId);
    }

    const sql = `
      SELECT DISTINCT ON (file_path)
        id,
        file_path   AS "filePath",
        module_name AS "moduleName",
        chunk_text  AS "chunkText",
        line_start  AS "lineStart",
        line_end    AS "lineEnd",
        nest_role   AS "nestRole",
        symbols     AS "symbols",
        imports     AS "imports",
        language    AS "language",
        framework   AS "framework",
        1.0 AS similarity
      FROM code_chunks
      WHERE imports IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(imports) AS imp
          WHERE imp->>'source' ILIKE $1
        )${repoClause}
      ORDER BY file_path, line_start
      LIMIT 50
    `;

    const rows: SearchResult[] = await this.dataSource.query(sql, params);
    this.logger.debug(`findByImport "${importSource}" returned ${rows.length} results`);
    return rows;
  }

  /**
   * Search by language filter — useful for "find all Python files" queries.
   */
  async searchByLanguage(
    language: string,
    repoId?: string,
    topK = 20,
  ): Promise<SearchResult[]> {
    const params: any[] = [language, topK];
    let repoClause = '';
    if (repoId) {
      repoClause = ' AND repo_id = $3';
      params.push(repoId);
    }
    const sql = `
      SELECT
        id,
        file_path   AS "filePath",
        module_name AS "moduleName",
        chunk_text  AS "chunkText",
        line_start  AS "lineStart",
        line_end    AS "lineEnd",
        nest_role   AS "nestRole",
        symbols     AS "symbols",
        language    AS "language",
        framework   AS "framework",
        1.0 AS similarity
      FROM code_chunks
      WHERE language = $1${repoClause}
      ORDER BY file_path, line_start
      LIMIT $2
    `;
    return this.dataSource.query(sql, params);
  }
}
