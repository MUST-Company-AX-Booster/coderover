import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  SearchService,
  SearchEmbeddingDimensionMismatchError,
} from './search.service';

const mockConfig = (overrides: Record<string, string> = {}) => ({
  get: jest.fn((key: string, defaultVal?: any) => {
    const map: Record<string, string> = {
      OPENAI_API_KEY: 'test-key',
      LLM_PROVIDER: 'local',
      OPENAI_EMBEDDING_DIMENSIONS: '1536',
      ...overrides,
    };
    return map[key] ?? defaultVal;
  }),
});

const mockDataSource = (rows: any[] = []) => ({
  query: jest.fn().mockResolvedValue(rows),
});

const makeEmbedding = (dim = 1536) => Array.from({ length: dim }, (_, i) => i * 0.001);

describe('SearchService', () => {
  let service: SearchService;
  let dataSource: ReturnType<typeof mockDataSource>;
  let configService: ReturnType<typeof mockConfig>;
  let openaiCreate: jest.Mock;

  const buildModule = async (configOverrides: Record<string, string> = {}, queryRows: any[] = []) => {
    configService = mockConfig(configOverrides);
    dataSource = mockDataSource(queryRows);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: ConfigService, useValue: configService },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<SearchService>(SearchService);
    // Mock openai embeddings
    openaiCreate = jest.fn().mockResolvedValue({
      data: [{ embedding: makeEmbedding(1536), index: 0 }],
    });
    (service as any).openai = { embeddings: { create: openaiCreate } };
    (service as any).resolvedEmbeddingDimensions = 1536;
  };

  beforeEach(() => buildModule());

  // ── Provider resolution ───────────────────────────────────────────────────

  describe('provider resolution', () => {
    it('resolves local provider from env', () => {
      expect((service as any).llmProvider).toBe('local');
    });

    it('resolves openai provider from sk- key', async () => {
      await buildModule({ OPENAI_API_KEY: 'sk-realkey', LLM_PROVIDER: '' });
      expect((service as any).llmProvider).toBe('openai');
    });

    it('resolves openrouter from sk-or- key', async () => {
      await buildModule({ OPENAI_API_KEY: 'sk-or-xxx', LLM_PROVIDER: '' });
      expect((service as any).llmProvider).toBe('openrouter');
    });

    it('resolves local from explicit LLM_PROVIDER=local', async () => {
      await buildModule({ LLM_PROVIDER: 'local' });
      expect((service as any).llmProvider).toBe('local');
    });
  });

  // ── search() routing ──────────────────────────────────────────────────────

  describe('search() routing', () => {
    it('returns empty array for empty query', async () => {
      const results = await service.search('');
      expect(results).toEqual([]);
    });

    it('returns empty array for whitespace-only query', async () => {
      const results = await service.search('   ');
      expect(results).toEqual([]);
    });

    it('uses keyword search for local provider', async () => {
      dataSource.query.mockResolvedValue([]);
      const spy = jest.spyOn(service as any, 'keywordSearch');
      await service.search('find user service');
      expect(spy).toHaveBeenCalled();
    });

    it('uses hybrid search for openai provider', async () => {
      await buildModule({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' });
      (service as any).resolvedEmbeddingDimensions = 1536;
      openaiCreate = jest.fn().mockResolvedValue({ data: [{ embedding: makeEmbedding(), index: 0 }] });
      (service as any).openai = { embeddings: { create: openaiCreate } };
      dataSource.query.mockResolvedValue([]);
      const spy = jest.spyOn(service as any, 'hybridSearch');
      await service.search('find payment service');
      expect(spy).toHaveBeenCalled();
    });

    it('falls back to keyword search when semantic fails', async () => {
      await buildModule({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' });
      (service as any).resolvedEmbeddingDimensions = 1536;
      (service as any).openai = {
        embeddings: { create: jest.fn().mockRejectedValue(new Error('API error')) },
      };
      dataSource.query.mockResolvedValue([]);
      const spy = jest.spyOn(service as any, 'keywordSearch');
      await service.search('test query');
      expect(spy).toHaveBeenCalled();
    });
  });

  // ── Keyword search SQL ────────────────────────────────────────────────────

  describe('keywordSearch SQL', () => {
    beforeEach(() => {
      dataSource.query.mockResolvedValue([
        { filePath: 'src/test.ts', moduleName: 'TestModule', chunkText: 'test', lineStart: 1, lineEnd: 10, similarity: 0.8, nestRole: 'service', symbols: null, language: 'typescript', framework: 'nestjs' },
      ]);
    });

    it('returns properly shaped results', async () => {
      const results = await service.search('test', { searchMode: 'keyword' });
      expect(results[0]).toHaveProperty('filePath');
      expect(results[0]).toHaveProperty('similarity');
    });

    it('applies module filter', async () => {
      await service.search('test', { moduleFilter: 'TestModule', searchMode: 'keyword' });
      const sql = dataSource.query.mock.calls[0][0] as string;
      expect(sql).toContain('module_name');
    });

    it('applies repoId filter', async () => {
      await service.search('test', { repoId: 'repo-uuid', searchMode: 'keyword' });
      const sql = dataSource.query.mock.calls[0][0] as string;
      expect(sql).toContain('repo_id');
    });

    it('applies repoIds array filter', async () => {
      await service.search('test', { repoIds: ['r1', 'r2'], searchMode: 'keyword' });
      const sql = dataSource.query.mock.calls[0][0] as string;
      expect(sql).toContain('ANY');
    });

    it('applies nestRole filter', async () => {
      await service.search('test', { nestRole: 'service', searchMode: 'keyword' });
      const sql = dataSource.query.mock.calls[0][0] as string;
      expect(sql).toContain('nest_role');
    });

    it('applies language filter', async () => {
      await service.search('test', { language: 'python', searchMode: 'keyword' });
      const sql = dataSource.query.mock.calls[0][0] as string;
      expect(sql).toContain('language');
    });

    it('applies framework filter', async () => {
      await service.search('test', { framework: 'nextjs', searchMode: 'keyword' });
      const sql = dataSource.query.mock.calls[0][0] as string;
      expect(sql).toContain('framework');
    });

    it('splits camelCase in keyword SQL', async () => {
      await service.search('PaymentService', { searchMode: 'keyword' });
      const sql = dataSource.query.mock.calls[0][0] as string;
      expect(sql).toContain('regexp_replace');
    });
  });

  // ── Hybrid search SQL ─────────────────────────────────────────────────────

  describe('hybridSearch SQL', () => {
    beforeEach(async () => {
      await buildModule({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' });
      (service as any).resolvedEmbeddingDimensions = 1536;
      (service as any).openai = {
        embeddings: { create: jest.fn().mockResolvedValue({ data: [{ embedding: makeEmbedding(), index: 0 }] }) },
      };
      dataSource.query.mockResolvedValue([]);
    });

    it('includes both semantic and BM25 weights in SQL', async () => {
      await (service as any).hybridSearch('test query', {});
      const sql = dataSource.query.mock.calls[0][0] as string;
      expect(sql).toContain('0.7');
      expect(sql).toContain('0.3');
      expect(sql).toContain('ts_rank_cd');
      expect(sql).toContain('<=>');
    });

    it('splits camelCase in hybrid BM25 expression', async () => {
      await (service as any).hybridSearch('PaymentService', {});
      const sql = dataSource.query.mock.calls[0][0] as string;
      expect(sql).toContain('regexp_replace');
    });
  });

  // ── embedQuery caching ────────────────────────────────────────────────────

  describe('embedQuery', () => {
    beforeEach(async () => {
      await buildModule({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' });
      (service as any).resolvedEmbeddingDimensions = 1536;
      openaiCreate = jest.fn().mockResolvedValue({ data: [{ embedding: makeEmbedding(), index: 0 }] });
      (service as any).openai = { embeddings: { create: openaiCreate } };
    });

    it('throws on empty query', async () => {
      await expect(service.embedQuery('')).rejects.toThrow('non-empty string');
    });

    it('returns cached result on second call', async () => {
      await service.embedQuery('hello world');
      await service.embedQuery('hello world');
      expect(openaiCreate).toHaveBeenCalledTimes(1);
    });

    it('throws on dimension mismatch', async () => {
      openaiCreate.mockResolvedValue({ data: [{ embedding: makeEmbedding(512), index: 0 }] });
      await expect(service.embedQuery('test')).rejects.toThrow(SearchEmbeddingDimensionMismatchError);
    });

    it('evicts oldest entry when cache exceeds max size', async () => {
      openaiCreate.mockImplementation(() => ({
        data: [{ embedding: makeEmbedding(1536), index: 0 }],
      }));
      // Fill cache to 50
      for (let i = 0; i < 50; i++) {
        await service.embedQuery(`query-${i}`);
      }
      expect((service as any).embeddingCache.size).toBe(50);
      // One more should evict the oldest
      await service.embedQuery('query-overflow');
      expect((service as any).embeddingCache.size).toBe(50);
    });
  });

  // ── findSymbol ────────────────────────────────────────────────────────────

  describe('findSymbol', () => {
    it('queries by symbol name', async () => {
      dataSource.query.mockResolvedValue([]);
      await service.findSymbol('UserService');
      const sql = dataSource.query.mock.calls[0][0] as string;
      expect(sql).toContain('symbols @>');
    });

    it('includes repoId filter when provided', async () => {
      dataSource.query.mockResolvedValue([]);
      await service.findSymbol('MyClass', { repoId: 'repo-1' });
      const sql = dataSource.query.mock.calls[0][0] as string;
      expect(sql).toContain('repo_id');
    });
  });

  // ── searchByModule ────────────────────────────────────────────────────────

  describe('searchByModule', () => {
    it('queries by module name', async () => {
      dataSource.query.mockResolvedValue([]);
      await service.searchByModule('BookingModule');
      const sql = dataSource.query.mock.calls[0][0] as string;
      expect(sql).toContain('module_name = $1');
    });

    it('includes language and framework columns', async () => {
      dataSource.query.mockResolvedValue([]);
      await service.searchByModule('BookingModule');
      const sql = dataSource.query.mock.calls[0][0] as string;
      expect(sql).toContain('language');
      expect(sql).toContain('framework');
    });
  });

  // ── findByImport ──────────────────────────────────────────────────────────

  describe('findByImport', () => {
    it('queries by import source', async () => {
      dataSource.query.mockResolvedValue([]);
      await service.findByImport('../entities/user.entity');
      const sql = dataSource.query.mock.calls[0][0] as string;
      expect(sql).toContain("imp->>'source' ILIKE");
    });
  });

  // ── searchByLanguage ──────────────────────────────────────────────────────

  describe('searchByLanguage', () => {
    it('queries by language column', async () => {
      dataSource.query.mockResolvedValue([]);
      await service.searchByLanguage('python');
      const sql = dataSource.query.mock.calls[0][0] as string;
      expect(sql).toContain('language = $1');
    });

    it('applies repoId filter', async () => {
      dataSource.query.mockResolvedValue([]);
      await service.searchByLanguage('go', 'repo-1');
      const sql = dataSource.query.mock.calls[0][0] as string;
      expect(sql).toContain('repo_id = $3');
    });
  });

  // ── getDistinctModules ────────────────────────────────────────────────────

  describe('getDistinctModules', () => {
    it('returns module names without repoId', async () => {
      dataSource.query.mockResolvedValue([{ module_name: 'BookingModule' }, { module_name: 'AuthModule' }]);
      const mods = await service.getDistinctModules();
      expect(mods).toEqual(['BookingModule', 'AuthModule']);
    });

    it('filters by repoId when provided', async () => {
      dataSource.query.mockResolvedValue([]);
      await service.getDistinctModules('repo-1');
      const sql = dataSource.query.mock.calls[0][0] as string;
      expect(sql).toContain('repo_id = $1');
    });
  });
});
