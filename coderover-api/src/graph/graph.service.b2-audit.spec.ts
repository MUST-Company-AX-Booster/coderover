import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { GraphService } from './graph.service';
import { MemgraphService } from './memgraph.service';
import { ConfidenceTaggerService } from './confidence-tagger.service';
import { EdgeProducerAudit } from '../entities/edge-producer-audit.entity';
import { computeEdgeId, computeNodeId } from './deterministic-ids';

/**
 * Phase 10 B2 — direct test of the private `recordEdgeAudit` hook invoked
 * after each Memgraph edge MERGE. Goes through `as any` so we don't have
 * to exercise the full syncRepoToMemgraph loop.
 */
describe('GraphService.recordEdgeAudit (Phase 10 B2)', () => {
  let service: GraphService;
  let auditRepo: any;

  beforeEach(async () => {
    auditRepo = { insert: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GraphService,
        { provide: DataSource, useValue: { query: jest.fn() } },
        {
          provide: MemgraphService,
          useValue: {
            getSession: jest.fn(),
            readQuery: jest.fn(),
            writeQuery: jest.fn(),
          },
        },
        { provide: getRepositoryToken(EdgeProducerAudit), useValue: auditRepo },
        ConfidenceTaggerService,
      ],
    }).compile();

    service = module.get(GraphService);
  });

  it('inserts an EXTRACTED audit row with the deterministic edge_id', async () => {
    await (service as any).recordEdgeAudit({
      srcFilePath: 'src/users/users.service.ts',
      srcSymbolKind: 'class',
      srcQualifiedName: 'UsersService',
      dstFilePath: 'src/users/users.service.ts',
      dstSymbolKind: 'method',
      dstQualifiedName: 'UsersService.findById',
      relationKind: 'DEFINES',
      refs: { filePath: 'src/users/users.service.ts' },
    });

    expect(auditRepo.insert).toHaveBeenCalledTimes(1);
    const row = auditRepo.insert.mock.calls[0][0];

    const expected = computeEdgeId(
      computeNodeId('src/users/users.service.ts', 'class', 'UsersService'),
      computeNodeId('src/users/users.service.ts', 'method', 'UsersService.findById'),
      'DEFINES',
    );
    expect(row.edgeId).toBe(expected);
    expect(row.producer).toBe(GraphService.GRAPH_SYNC_PRODUCER);
    expect(row.producerKind).toBe('EXTRACTED');
    expect(row.producerConfidence).toBe(1.0);
    expect(row.relationKind).toBe('DEFINES');
    expect(row.evidenceRef).toEqual({ filePath: 'src/users/users.service.ts' });
  });

  it('never throws when the audit insert fails', async () => {
    auditRepo.insert.mockRejectedValueOnce(new Error('pg down'));
    await expect(
      (service as any).recordEdgeAudit({
        srcFilePath: 'a',
        srcSymbolKind: 'file',
        srcQualifiedName: 'a',
        dstFilePath: 'b',
        dstSymbolKind: 'file',
        dstQualifiedName: 'b',
        relationKind: 'IMPORTS',
      }),
    ).resolves.toBeUndefined();
  });

  it('produces stable edge_ids across repeated invocations with identical inputs', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      auditRepo.insert.mockClear();
      await (service as any).recordEdgeAudit({
        srcFilePath: 'a.ts',
        srcSymbolKind: 'file',
        srcQualifiedName: 'a.ts',
        dstFilePath: 'b.ts',
        dstSymbolKind: 'file',
        dstQualifiedName: 'b.ts',
        relationKind: 'IMPORTS',
      });
      ids.push(auditRepo.insert.mock.calls[0][0].edgeId);
    }
    expect(new Set(ids).size).toBe(1);
  });
});
