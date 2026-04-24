import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EmbedderService } from './embedder.service';
import { ChunkResult } from './chunker.service';
import { EdgeProducerAudit } from '../entities/edge-producer-audit.entity';
import { ConfidenceTaggerService } from '../graph/confidence-tagger.service';

// Mock OpenAI
jest.mock('openai', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      embeddings: {
        create: jest.fn(),
      },
    })),
  };
});

describe('EmbedderService', () => {
  let service: EmbedderService;
  let mockDataSource: Partial<DataSource>;
  let mockOpenAICreate: jest.Mock;

  const createChunk = (index: number): ChunkResult => ({
    chunkText: `// File: src/test.ts\n---\nchunk content ${index}`,
    rawText: `chunk content ${index}`,
    filePath: 'src/test.ts',
    moduleName: 'TestModule',
    lineStart: index * 10 + 1,
    lineEnd: (index + 1) * 10,
    commitSha: 'abc123',
    symbols: [],
    nestRole: 'unknown',
    imports: [],
    exports: [],
    language: 'typescript',
    framework: null,
  });

  const createEmbedding = (index: number): number[] => {
    return Array.from({ length: 1536 }, (_, i) => (index + i) * 0.001);
  };

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    (global as any).fetch = jest.fn();
    mockDataSource = {
      query: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmbedderService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'OPENAI_API_KEY') return 'test-api-key';
              if (key === 'OPENAI_BASE_URL') return undefined;
              if (key === 'OPENAI_EMBEDDING_MODEL') return 'text-embedding-3-large';
              if (key === 'OPENAI_EMBEDDING_DIMENSIONS') return 1536;
              return undefined;
            }),
          },
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
        {
          provide: getRepositoryToken(EdgeProducerAudit),
          useValue: { insert: jest.fn().mockResolvedValue(undefined) },
        },
        ConfidenceTaggerService,
      ],
    }).compile();

    service = module.get<EmbedderService>(EmbedderService);

    // Mock sleep to avoid actual delays in tests
    (service as any).sleep = jest.fn().mockResolvedValue(undefined);

    // Access the mock
    mockOpenAICreate = (service as any).openai.embeddings.create;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('toPgVectorString', () => {
    it('should convert float array to pgvector format', () => {
      const embedding = [1.0, 2.0, 3.0, 4.5];
      const result = service.toPgVectorString(embedding);
      expect(result).toBe('[1,2,3,4.5]');
    });

    it('should handle empty array', () => {
      const result = service.toPgVectorString([]);
      expect(result).toBe('[]');
    });

    it('should handle negative numbers', () => {
      const result = service.toPgVectorString([-0.5, 0.5]);
      expect(result).toBe('[-0.5,0.5]');
    });
  });

  describe('embedAndUpsert', () => {
    it('should process chunks in batches of 20', async () => {
      // Create 25 chunks — should produce 2 batches (20 + 5)
      const chunks = Array.from({ length: 25 }, (_, i) => createChunk(i));

      mockOpenAICreate
        .mockResolvedValueOnce({
          data: Array.from({ length: 20 }, (_, i) => ({
            index: i,
            embedding: createEmbedding(i),
          })),
        })
        .mockResolvedValueOnce({
          data: Array.from({ length: 5 }, (_, i) => ({
            index: i,
            embedding: createEmbedding(i + 20),
          })),
        });

      const result = await service.embedAndUpsert(chunks);

      expect(mockOpenAICreate).toHaveBeenCalledTimes(2);
      expect(result.chunksProcessed).toBe(25);
      expect(result.chunksUpserted).toBe(25);
    });

    it('should handle single batch', async () => {
      const chunks = Array.from({ length: 5 }, (_, i) => createChunk(i));

      mockOpenAICreate.mockResolvedValueOnce({
        data: Array.from({ length: 5 }, (_, i) => ({
          index: i,
          embedding: createEmbedding(i),
        })),
      });

      const result = await service.embedAndUpsert(chunks);

      expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
      expect(result.chunksProcessed).toBe(5);
      expect(result.chunksUpserted).toBe(5);
    });

    it('should report errors for failed batches', async () => {
      const chunks = [createChunk(0)];

      mockOpenAICreate
        .mockRejectedValueOnce(new Error('Rate limit'))
        .mockRejectedValueOnce(new Error('Rate limit'))
        .mockRejectedValueOnce(new Error('Rate limit'));

      const result = await service.embedAndUpsert(chunks);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.chunksUpserted).toBe(0);
    });

    it('should upsert chunks with null embedding for local provider on dimension mismatch', async () => {
      const chunks = [createChunk(0)];

      const configService = (service as any).configService as ConfigService;
      (configService.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'OPENAI_API_KEY') return 'test-api-key';
        if (key === 'OPENAI_BASE_URL') return 'http://localhost:1234/v1';
        if (key === 'LLM_PROVIDER') return 'local';
        if (key === 'OPENAI_EMBEDDING_MODEL') return 'text-embedding-3-large';
        if (key === 'OPENAI_EMBEDDING_DIMENSIONS') return 1536;
        return undefined;
      });
      (service as any).llmProvider = 'local';

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValue(
          JSON.stringify({
            data: [{ index: 0, embedding: Array.from({ length: 192 }, () => 0.1) }],
          }),
        ),
      });

      const querySpy = mockDataSource.query as jest.Mock;
      querySpy.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('pg_catalog.format_type')) {
          return Promise.resolve([{ typmod: 1536, formatted: 'vector(1536)' }]);
        }
        return Promise.resolve([]);
      });

      const result = await service.embedAndUpsert(chunks);
      expect(result.chunksUpserted).toBe(1);
      expect(result.errors).toEqual([]);

      const insertCall = querySpy.mock.calls.find((c) => String(c[0]).includes('INSERT INTO code_chunks'));
      expect(insertCall).toBeDefined();
      expect(insertCall[1][4]).toBeNull();
    });
  });

  describe('getEmbeddingsWithRetry', () => {
    it('should retry on failure with exponential backoff', async () => {
      mockOpenAICreate
        .mockRejectedValueOnce(new Error('Rate limit'))
        .mockResolvedValueOnce({
          data: [{ index: 0, embedding: createEmbedding(0) }],
        });

      const result = await service.getEmbeddingsWithRetry(['test text']);

      expect(mockOpenAICreate).toHaveBeenCalledTimes(2);
      expect(result.embeddings).toHaveLength(1);
      expect(result.embeddings[0]).toHaveLength(1536);
      expect(result.dimensions).toBe(1536);
    });

    it('should throw after max retries', async () => {
      mockOpenAICreate
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'))
        .mockRejectedValueOnce(new Error('Error 3'));

      await expect(service.getEmbeddingsWithRetry(['test'])).rejects.toThrow('Error 3');

      expect(mockOpenAICreate).toHaveBeenCalledTimes(3);
    });
  });
});
