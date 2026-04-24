import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EmbedderService } from './embedder.service';
import { EdgeProducerAudit } from '../entities/edge-producer-audit.entity';
import { ConfidenceTaggerService } from '../graph/confidence-tagger.service';
import { computeEdgeId, computeNodeId } from '../graph/deterministic-ids';

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    embeddings: { create: jest.fn() },
  })),
}));

/**
 * Phase 10 B2 — proves that each Postgres edge-table INSERT in
 * `upsertChunk` is followed by an `edge_producer_audit` row with the
 * correct edge_id + AST classification.
 */
describe('EmbedderService (Phase 10 B2 audit wire-up)', () => {
  let service: EmbedderService;
  let auditRepo: any;
  let dataSource: any;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    dataSource = { query: jest.fn().mockResolvedValue([]) };
    auditRepo = { insert: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmbedderService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'OPENAI_API_KEY') return 'test-key';
              if (key === 'OPENAI_EMBEDDING_DIMENSIONS') return 1536;
              return undefined;
            }),
          },
        },
        { provide: DataSource, useValue: dataSource },
        { provide: getRepositoryToken(EdgeProducerAudit), useValue: auditRepo },
        ConfidenceTaggerService,
      ],
    }).compile();

    service = module.get(EmbedderService);
    // Force resolveEmbeddingDimensions to return 1536 without hitting pg.
    (service as any).resolvedEmbeddingDimensions = 1536;
  });

  function chunkWith(extras: Record<string, unknown>): any {
    return {
      chunkText: 'x',
      filePath: 'src/a.ts',
      moduleName: 'A',
      lineStart: 1,
      lineEnd: 10,
      commitSha: 'deadbeef',
      symbols: [],
      nestRole: null,
      imports: [],
      exports: [],
      language: 'typescript',
      framework: null,
      ...extras,
    };
  }

  it('records an EXTRACTED audit row for each code_methods insert', async () => {
    await service.upsertChunk(
      chunkWith({
        methods: [
          { className: 'Foo', name: 'bar', startLine: 1, endLine: 4, parameters: [] },
        ],
      }),
      null,
      'repo-uuid',
    );

    // First dataSource.query = INSERT INTO code_chunks, second = code_methods.
    expect(dataSource.query).toHaveBeenCalled();
    expect(auditRepo.insert).toHaveBeenCalledTimes(1);
    const row = auditRepo.insert.mock.calls[0][0];

    const expectedEdgeId = computeEdgeId(
      computeNodeId('src/a.ts', 'class', 'Foo'),
      computeNodeId('src/a.ts', 'method', 'Foo.bar'),
      'DEFINES',
    );
    expect(row).toMatchObject({
      edgeId: expectedEdgeId,
      relationKind: 'DEFINES',
      producer: EmbedderService.AST_INGEST_PRODUCER,
      producerKind: 'EXTRACTED',
      producerConfidence: 1.0,
    });
  });

  it('records an EXTRACTED audit row for each code_calls insert', async () => {
    await service.upsertChunk(
      chunkWith({
        callSites: [
          {
            callerName: 'main',
            callerKind: 'function',
            calleeName: 'helper',
            calleeQualified: 'lib.helper',
            line: 7,
          },
        ],
      }),
      null,
      'repo-uuid',
    );

    expect(auditRepo.insert).toHaveBeenCalledTimes(1);
    const row = auditRepo.insert.mock.calls[0][0];
    expect(row.relationKind).toBe('CALLS');
    expect(row.producerKind).toBe('EXTRACTED');
    expect(row.evidenceRef).toMatchObject({
      source: 'code_calls',
      callerName: 'main',
      calleeName: 'helper',
      calleeQualified: 'lib.helper',
    });
  });

  it('records an EXTRACTED audit row for each code_inheritance insert with a parent class', async () => {
    await service.upsertChunk(
      chunkWith({
        inheritance: [{ className: 'Child', extends: 'Parent', implements: [] }],
      }),
      null,
      'repo-uuid',
    );

    expect(auditRepo.insert).toHaveBeenCalledTimes(1);
    const row = auditRepo.insert.mock.calls[0][0];
    expect(row.relationKind).toBe('INHERITS');
    expect(row.producerKind).toBe('EXTRACTED');
  });

  it('does not record inheritance audit when extends is empty', async () => {
    await service.upsertChunk(
      chunkWith({
        inheritance: [{ className: 'Solo', extends: null, implements: [] }],
      }),
      null,
      'repo-uuid',
    );

    expect(auditRepo.insert).not.toHaveBeenCalled();
  });

  it('never throws when the audit insert itself fails', async () => {
    auditRepo.insert.mockRejectedValue(new Error('pg down'));
    await expect(
      service.upsertChunk(
        chunkWith({
          methods: [
            { className: 'Foo', name: 'bar', startLine: 1, endLine: 2, parameters: [] },
          ],
        }),
        null,
        'repo-uuid',
      ),
    ).resolves.toBeUndefined();
  });

  it('does not insert audit rows when repoId is omitted (unregistered repo path)', async () => {
    await service.upsertChunk(
      chunkWith({
        methods: [
          { className: 'Foo', name: 'bar', startLine: 1, endLine: 2, parameters: [] },
        ],
      }),
      null,
      // repoId omitted
    );
    expect(auditRepo.insert).not.toHaveBeenCalled();
  });
});
