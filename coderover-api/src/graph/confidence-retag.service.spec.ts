import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfidenceRetagService } from './confidence-retag.service';
import { MemgraphService } from './memgraph.service';
import { EdgeProducerAudit } from '../entities/edge-producer-audit.entity';

/**
 * Phase 10 B1 — Critical-gap test #6: "Background re-tag job correctness on AMBIGUOUS defaults".
 *
 * These tests verify the re-tag job's behavior independent of producers (B2) and
 * deterministic edge IDs (C2-bis), which haven't landed yet. The job must:
 *
 *   - No-op cleanly when the audit table is empty (preserves AMBIGUOUS defaults).
 *   - Promote an edge to EXTRACTED or INFERRED based on the producer's recorded kind.
 *   - Pick the highest-authority classification when multiple producers conflict.
 *   - Skip (not fail) when the audit references an edge not yet in Memgraph.
 *   - Never write to Memgraph in dry-run mode.
 */
describe('ConfidenceRetagService', () => {
  let service: ConfidenceRetagService;
  let auditRepo: any;
  let memgraph: any;

  function fakeAudit(partial: Partial<EdgeProducerAudit>): EdgeProducerAudit {
    return {
      id: partial.id ?? 'uuid-' + Math.random(),
      edgeId: partial.edgeId ?? 'edge-A',
      relationKind: partial.relationKind ?? 'CALLS',
      producer: partial.producer ?? 'ast',
      producerKind: partial.producerKind ?? 'EXTRACTED',
      producerConfidence: partial.producerConfidence ?? null,
      orgId: partial.orgId ?? null,
      evidenceRef: partial.evidenceRef ?? null,
      createdAt: partial.createdAt ?? new Date(),
    };
  }

  beforeEach(async () => {
    auditRepo = {
      createQueryBuilder: jest.fn(),
    };
    memgraph = {
      writeQuery: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConfidenceRetagService,
        { provide: getRepositoryToken(EdgeProducerAudit), useValue: auditRepo },
        { provide: MemgraphService, useValue: memgraph },
      ],
    }).compile();

    service = module.get(ConfidenceRetagService);
  });

  function mockAuditPages(...pages: EdgeProducerAudit[][]) {
    let call = 0;
    auditRepo.createQueryBuilder.mockImplementation(() => {
      const qb: any = {
        orderBy: () => qb,
        addOrderBy: () => qb,
        skip: () => qb,
        take: () => qb,
        getMany: async () => pages[call++] ?? [],
      };
      return qb;
    });
  }

  function mockMemgraphUpdated(n: number) {
    memgraph.writeQuery.mockResolvedValue([
      { get: (_key: string) => n },
    ]);
  }

  it('no-ops cleanly when audit table is empty — critical-gap test #6', async () => {
    mockAuditPages([]);

    const result = await service.run();

    expect(result).toEqual({
      auditRowsScanned: 0,
      edgesUpdated: 0,
      edgesSkipped: 0,
      batches: 0,
    });
    expect(memgraph.writeQuery).not.toHaveBeenCalled();
  });

  it('promotes a single edge to EXTRACTED from the audit record', async () => {
    mockAuditPages([
      fakeAudit({ edgeId: 'edge-A', producerKind: 'EXTRACTED', producerConfidence: 1.0 }),
    ]);
    mockMemgraphUpdated(1);

    const result = await service.run();

    expect(result.edgesUpdated).toBe(1);
    expect(result.edgesSkipped).toBe(0);
    expect(memgraph.writeQuery).toHaveBeenCalledTimes(1);
    const [cypher, params] = memgraph.writeQuery.mock.calls[0];
    expect(cypher).toMatch(/SET e\.confidence = \$kind/);
    expect(params).toEqual({ edgeId: 'edge-A', kind: 'EXTRACTED', score: 1.0 });
  });

  it('picks EXTRACTED over INFERRED when one edge has both', async () => {
    mockAuditPages([
      fakeAudit({ edgeId: 'edge-A', producerKind: 'INFERRED', producerConfidence: 0.6 }),
      fakeAudit({ edgeId: 'edge-A', producerKind: 'EXTRACTED', producerConfidence: 1.0 }),
    ]);
    mockMemgraphUpdated(1);

    await service.run();

    expect(memgraph.writeQuery).toHaveBeenCalledTimes(1);
    const params = memgraph.writeQuery.mock.calls[0][1];
    expect(params.kind).toBe('EXTRACTED');
    expect(params.score).toBe(1.0);
  });

  it('picks INFERRED over AMBIGUOUS when only LLM producers exist', async () => {
    mockAuditPages([
      fakeAudit({ edgeId: 'edge-B', producerKind: 'AMBIGUOUS', producerConfidence: null }),
      fakeAudit({ edgeId: 'edge-B', producerKind: 'INFERRED', producerConfidence: 0.4 }),
    ]);
    mockMemgraphUpdated(1);

    await service.run();

    const params = memgraph.writeQuery.mock.calls[0][1];
    expect(params.kind).toBe('INFERRED');
    expect(params.score).toBe(0.4);
  });

  it('counts skips when the Memgraph edge is not found', async () => {
    mockAuditPages([
      fakeAudit({ edgeId: 'edge-missing', producerKind: 'EXTRACTED' }),
    ]);
    mockMemgraphUpdated(0);

    const result = await service.run();

    expect(result.edgesUpdated).toBe(0);
    expect(result.edgesSkipped).toBe(1);
  });

  it('never writes to Memgraph in dry-run mode', async () => {
    mockAuditPages([
      fakeAudit({ edgeId: 'edge-A', producerKind: 'EXTRACTED' }),
    ]);

    const result = await service.run({ dryRun: true });

    expect(result.edgesUpdated).toBe(1);
    expect(memgraph.writeQuery).not.toHaveBeenCalled();
  });

  it('respects maxUpdates hard cap', async () => {
    mockAuditPages([
      fakeAudit({ edgeId: 'edge-A', producerKind: 'EXTRACTED' }),
      fakeAudit({ edgeId: 'edge-B', producerKind: 'EXTRACTED' }),
      fakeAudit({ edgeId: 'edge-C', producerKind: 'EXTRACTED' }),
    ]);
    mockMemgraphUpdated(1);

    const result = await service.run({ maxUpdates: 2 });

    expect(result.edgesUpdated).toBe(2);
    expect(memgraph.writeQuery).toHaveBeenCalledTimes(2);
  });
});
