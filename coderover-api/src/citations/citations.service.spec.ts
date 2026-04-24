import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { CitationsService } from './citations.service';
import { RagCitation } from '../entities/rag-citation.entity';
import { PrReviewFinding } from '../entities/pr-review-finding.entity';
import { EdgeProducerAudit } from '../entities/edge-producer-audit.entity';

/**
 * Phase 10 B4 — CitationsService.
 *
 * These tests pin the invariants clients rely on:
 *
 *   - Input order is preserved across both tables.
 *   - Missing / cross-org ids become `kind: 'not_found'` (not a 404).
 *   - The batch uses ONE `find()` call per id-resolution table. If this
 *     test ever starts failing with N calls, someone has reintroduced
 *     the N+1 the endpoint exists to eliminate.
 *   - Similar-citations cap at 3 and never include the source id.
 */
describe('CitationsService', () => {
  let service: CitationsService;
  let ragRepo: any;
  let findingRepo: any;
  let edgeAuditRepo: any;

  const ORG = 'org-1';
  const OTHER_ORG = 'org-2';

  const citationRow = (overrides: Partial<RagCitation> = {}): RagCitation =>
    ({
      id: 'cit-1',
      chatMessageId: 'msg-1',
      orgId: ORG,
      filePath: 'src/a.ts',
      lineStart: 10,
      lineEnd: 20,
      similarity: 0.9,
      confidence: 'INFERRED',
      confidenceScore: 0.62,
      evidenceRef: null,
      producer: 'llm',
      createdAt: new Date('2026-04-17T00:00:00.000Z'),
      ...overrides,
    }) as unknown as RagCitation;

  const findingRow = (overrides: Partial<PrReviewFinding> = {}): PrReviewFinding =>
    ({
      id: 'fnd-1',
      prReviewId: 'pr-1',
      orgId: ORG,
      file: 'src/b.ts',
      line: 42,
      title: 'Check input',
      body: 'Validate at the boundary',
      severity: 'medium',
      category: 'correctness',
      confidence: 'AMBIGUOUS',
      confidenceScore: null,
      evidenceRef: null,
      producer: null,
      createdAt: new Date('2026-04-17T00:00:00.000Z'),
      ...overrides,
    }) as unknown as PrReviewFinding;

  beforeEach(async () => {
    ragRepo = { find: jest.fn().mockResolvedValue([]) };
    findingRepo = { find: jest.fn().mockResolvedValue([]) };
    edgeAuditRepo = { find: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CitationsService,
        { provide: getRepositoryToken(RagCitation), useValue: ragRepo },
        { provide: getRepositoryToken(PrReviewFinding), useValue: findingRepo },
        { provide: getRepositoryToken(EdgeProducerAudit), useValue: edgeAuditRepo },
      ],
    }).compile();

    service = module.get(CitationsService);
  });

  it('returns results in input order across both tables', async () => {
    ragRepo.find.mockResolvedValueOnce([citationRow({ id: 'cit-1' })]);
    findingRepo.find.mockResolvedValueOnce([findingRow({ id: 'fnd-1' })]);

    const res = await service.getBatchEvidence(['fnd-1', 'cit-1'], ORG);

    expect(res.map((r) => r.id)).toEqual(['fnd-1', 'cit-1']);
    expect(res[0].kind).toBe('finding');
    expect(res[1].kind).toBe('citation');
  });

  it('tags missing ids as kind: "not_found" without 404ing the batch', async () => {
    ragRepo.find.mockResolvedValue([citationRow({ id: 'cit-1' })]);
    findingRepo.find.mockResolvedValue([]);

    const res = await service.getBatchEvidence(['cit-1', 'nope'], ORG);

    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({ id: 'cit-1', kind: 'citation', tag: 'INFERRED' });
    expect(res[1]).toMatchObject({
      id: 'nope',
      kind: 'not_found',
      tag: null,
      score: null,
      evidence: null,
    });
  });

  it('treats cross-org ids as not_found (no existence leak)', async () => {
    // The repo mock only returns rows matching the passed orgId, mirroring
    // the TypeORM behavior. A cross-org citation is filtered out at the
    // `where: { orgId }` level and never appears in the map.
    ragRepo.find.mockImplementation(async ({ where }: any) => {
      if (where.orgId !== ORG) return [];
      return [citationRow({ id: 'cit-1', orgId: ORG })];
    });
    findingRepo.find.mockResolvedValue([]);

    const resMine = await service.getBatchEvidence(['cit-1'], ORG);
    expect(resMine[0].kind).toBe('citation');

    const resTheirs = await service.getBatchEvidence(['cit-1'], OTHER_ORG);
    expect(resTheirs[0]).toMatchObject({ id: 'cit-1', kind: 'not_found', tag: null });
  });

  it('runs exactly one id-resolution query per table, not N (parallelism guard)', async () => {
    ragRepo.find.mockResolvedValue([]);
    findingRepo.find.mockResolvedValue([]);

    const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    await service.getBatchEvidence(ids, ORG);

    expect(ragRepo.find).toHaveBeenCalledTimes(1);
    expect(findingRepo.find).toHaveBeenCalledTimes(1);
    // The single call should pass the full id list to a single In(...)
    // clause so the query plan is a set-lookup, not a per-id loop.
    expect(ragRepo.find.mock.calls[0][0].where.id).toEqual(In(ids));
    expect(findingRepo.find.mock.calls[0][0].where.id).toEqual(In(ids));
  });

  it('dedupes duplicate input ids before querying', async () => {
    ragRepo.find.mockResolvedValue([]);
    findingRepo.find.mockResolvedValue([]);

    await service.getBatchEvidence(['a', 'a', 'b', 'a'], ORG);

    expect(ragRepo.find.mock.calls[0][0].where.id).toEqual(In(['a', 'b']));
  });

  it('caps similar_citations at 3 and excludes the source id', async () => {
    const source = citationRow({ id: 'src', filePath: 'src/x.ts' });
    const siblings = [
      citationRow({ id: 'sib-1', filePath: 'src/x.ts', similarity: 0.95 }),
      citationRow({ id: 'sib-2', filePath: 'src/x.ts', similarity: 0.9 }),
      citationRow({ id: 'sib-3', filePath: 'src/x.ts', similarity: 0.85 }),
      citationRow({ id: 'sib-4', filePath: 'src/x.ts', similarity: 0.8 }),
    ];

    ragRepo.find
      // first call: id-resolution for the batch ids
      .mockResolvedValueOnce([source])
      // second call: similar-citations batch lookup
      .mockResolvedValueOnce(siblings);
    findingRepo.find.mockResolvedValue([]);

    const res = await service.getBatchEvidence(['src'], ORG);

    expect(res[0].evidence).not.toBeNull();
    const similar = res[0].evidence!.similar_citations;
    expect(similar).toHaveLength(3);
    expect(similar.map((s) => s.id)).toEqual(['sib-1', 'sib-2', 'sib-3']);
    expect(similar.map((s) => s.id)).not.toContain('src');
  });

  it('attaches upstream_audits when evidence_ref carries an edge_id', async () => {
    const cit = citationRow({
      id: 'cit-1',
      evidenceRef: { edge_id: 'edge-X' },
    });
    ragRepo.find.mockResolvedValueOnce([cit]).mockResolvedValueOnce([]);
    findingRepo.find.mockResolvedValue([]);
    edgeAuditRepo.find.mockResolvedValue([
      {
        id: 'a-1',
        edgeId: 'edge-X',
        relationKind: 'CALLS',
        producer: 'ast',
        producerKind: 'EXTRACTED',
        producerConfidence: 1.0,
        orgId: ORG,
        evidenceRef: null,
        createdAt: new Date('2026-04-17T01:02:03.000Z'),
      },
    ]);

    const res = await service.getBatchEvidence(['cit-1'], ORG);

    expect(res[0].evidence!.upstream_audits).toEqual([
      {
        producer: 'ast',
        producer_kind: 'EXTRACTED',
        producer_confidence: 1.0,
        created_at: '2026-04-17T01:02:03.000Z',
      },
    ]);
    // Edge audits are batched regardless of how many citations reference
    // an edge_id — one query for the whole batch.
    expect(edgeAuditRepo.find).toHaveBeenCalledTimes(1);
  });

  it('returns empty array for empty input without touching repos', async () => {
    const res = await service.getBatchEvidence([], ORG);
    expect(res).toEqual([]);
    expect(ragRepo.find).not.toHaveBeenCalled();
    expect(findingRepo.find).not.toHaveBeenCalled();
  });
});
