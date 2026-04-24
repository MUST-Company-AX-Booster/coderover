/**
 * Phase 10 A5 — B1/B2/C2 confidence end-to-end.
 *
 * The originally-scoped test said "trigger a new chat write through the
 * real CopilotService (via HTTP)" — but CopilotService pulls in OpenAI +
 * a full SearchService + embedder, which requires the real infrastructure
 * A5 is designed to NOT depend on. We instead exercise the same
 * producer-pipeline path at the service boundary:
 *
 *   1. `ConfidenceTaggerService.tag(...)` — prove an LLM-classified
 *      producer with a self-score becomes `INFERRED`, and an ast-classified
 *      producer becomes `EXTRACTED` with score 1.0. This is the single
 *      source of truth every producer is supposed to call at write time
 *      (B2 contract).
 *
 *   2. Seed an `edge_producer_audit` row and a matching Memgraph edge
 *      (via the recording MemgraphService mock). Run
 *      `ConfidenceRetagService.run()` — assert the Cypher it fires
 *      promotes the edge's `confidence` property.
 *
 *   3. Run `GraphMigrationService.runPending()` and assert
 *      `phase10_default_edge_confidence` fires exactly once on a fresh
 *      migrations table (critical-gap test #6 — "no-op on pre-Phase-10
 *      edges without breaking the default").
 *
 * These services are wired with lightweight mocks for their external
 * deps — the goal is NOT a new copy of their unit tests but an
 * end-to-end assertion that the wired DI graph (tagger → audit →
 * retag → migration) holds together and the Cypher strings haven't
 * drifted between workstreams.
 */

import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ConfidenceTaggerService } from '../../../../coderover-api/src/graph/confidence-tagger.service';
import { ConfidenceRetagService } from '../../../../coderover-api/src/graph/confidence-retag.service';
import {
  GraphMigrationService,
  GRAPH_MIGRATIONS,
} from '../../../../coderover-api/src/graph/graph-migration.service';
import { MemgraphService } from '../../../../coderover-api/src/graph/memgraph.service';
import { EdgeProducerAudit } from '../../../../coderover-api/src/entities/edge-producer-audit.entity';
import { GraphMigration } from '../../../../coderover-api/src/entities/graph-migration.entity';
import { InMemoryRepo, buildEdgeAudit } from '../setup/fixtures';

/**
 * Recording Memgraph mock. Logs every Cypher invocation with its params
 * so specs can assert the exact queries fired.
 */
class RecordingMemgraph {
  readonly writes: Array<{ cypher: string; params: Record<string, any> }> = [];
  readonly reads: Array<{ cypher: string; params: Record<string, any> }> = [];
  // Configurable response for writeQuery — tests set this per assertion.
  writeResponse: Array<{ get(k: string): number }> = [
    { get: (_k: string) => 1 },
  ];

  async writeQuery(cypher: string, params: Record<string, any> = {}): Promise<any[]> {
    this.writes.push({ cypher, params });
    return this.writeResponse;
  }

  async readQuery(cypher: string, params: Record<string, any> = {}): Promise<any[]> {
    this.reads.push({ cypher, params });
    return [];
  }
}

describe('A5 — B2 ConfidenceTaggerService policy (end-to-end)', () => {
  let tagger: ConfidenceTaggerService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      providers: [ConfidenceTaggerService],
    }).compile();
    tagger = module.get(ConfidenceTaggerService);
  });

  it('ast producer → EXTRACTED @ 1.0', () => {
    const result = tagger.tag({
      producer: 'ast:graph-sync',
      producerKind: 'ast',
    });
    expect(result.tag).toBe('EXTRACTED');
    expect(result.score).toBe(1.0);
  });

  it('llm producer with self-score → INFERRED clamped to [0,1]', () => {
    const ok = tagger.tag({
      producer: 'hybrid-search',
      producerKind: 'llm',
      selfScore: 0.62,
    });
    expect(ok.tag).toBe('INFERRED');
    expect(ok.score).toBeCloseTo(0.62);

    const overclamp = tagger.tag({
      producer: 'hybrid-search',
      producerKind: 'llm',
      selfScore: 2.5,
    });
    expect(overclamp.tag).toBe('INFERRED');
    expect(overclamp.score).toBe(1);
  });

  it('llm producer without a score → AMBIGUOUS', () => {
    const result = tagger.tag({
      producer: 'hybrid-search',
      producerKind: 'llm',
    });
    expect(result.tag).toBe('AMBIGUOUS');
    expect(result.score).toBeNull();
  });

  it('hybrid producer with low agreement → AMBIGUOUS', () => {
    const result = tagger.tag({
      producer: 'ensemble',
      producerKind: 'hybrid',
      selfScore: 0.4, // below the 0.5 HYBRID_LOW_AGREEMENT_THRESHOLD
    });
    expect(result.tag).toBe('AMBIGUOUS');
  });
});

describe('A5 — B1 ConfidenceRetagService promotes audit rows end-to-end', () => {
  let service: ConfidenceRetagService;
  let auditRepo: InMemoryRepo<EdgeProducerAudit>;
  let memgraph: RecordingMemgraph;

  beforeEach(async () => {
    auditRepo = new InMemoryRepo<EdgeProducerAudit>();
    memgraph = new RecordingMemgraph();

    const module = await Test.createTestingModule({
      providers: [
        ConfidenceRetagService,
        { provide: getRepositoryToken(EdgeProducerAudit), useValue: auditRepo },
        { provide: MemgraphService, useValue: memgraph },
      ],
    }).compile();

    service = module.get(ConfidenceRetagService);
  });

  it('fires a SET cypher that writes confidence + score per edge_id', async () => {
    // Seed two audits for the same edge — EXTRACTED beats INFERRED per
    // authorityRank, so that winner is what should hit Memgraph.
    const edgeId = 'edge-retag-e2e';
    auditRepo.seed(
      buildEdgeAudit({
        edgeId,
        producer: 'llm/gpt-4o-mini',
        producerKind: 'INFERRED',
        producerConfidence: 0.6,
      }) as any,
    );
    auditRepo.seed(
      buildEdgeAudit({
        edgeId,
        producer: 'ast:graph-sync',
        producerKind: 'EXTRACTED',
        producerConfidence: 1.0,
      }) as any,
    );

    const result = await service.run({ batchSize: 100 });
    expect(result.auditRowsScanned).toBe(2);
    expect(result.edgesUpdated).toBe(1);

    // Exactly one SET was issued targeting our edge.
    const setWrites = memgraph.writes.filter((w) => /SET\s+e\.confidence/.test(w.cypher));
    expect(setWrites).toHaveLength(1);
    expect(setWrites[0].params).toMatchObject({
      edgeId,
      kind: 'EXTRACTED',
      score: 1.0,
    });
  });

  it('dry-run does not write to Memgraph', async () => {
    auditRepo.seed(
      buildEdgeAudit({
        edgeId: 'edge-dry',
        producerKind: 'INFERRED',
        producerConfidence: 0.5,
      }) as any,
    );

    const result = await service.run({ dryRun: true });
    expect(result.edgesUpdated).toBe(1);
    expect(memgraph.writes).toHaveLength(0);
  });
});

describe('A5 — GraphMigrationService fires phase10_default_edge_confidence once', () => {
  let service: GraphMigrationService;
  let migrationRepo: InMemoryRepo<GraphMigration>;
  let memgraph: RecordingMemgraph;

  beforeEach(async () => {
    migrationRepo = new InMemoryRepo<GraphMigration>();
    memgraph = new RecordingMemgraph();

    const module = await Test.createTestingModule({
      providers: [
        GraphMigrationService,
        { provide: getRepositoryToken(GraphMigration), useValue: migrationRepo },
        { provide: MemgraphService, useValue: memgraph },
      ],
    }).compile();

    service = module.get(GraphMigrationService);
  });

  it('applies phase10_default_edge_confidence on an empty migrations table', async () => {
    const ran = await service.runPending();

    expect(ran).toContain('phase10_default_edge_confidence');
    // Find the SET confidence = 'AMBIGUOUS' write.
    const backfill = memgraph.writes.find((w) =>
      /SET\s+e\.confidence\s*=\s*'AMBIGUOUS'/.test(w.cypher),
    );
    expect(backfill).toBeDefined();
    // Exactly one phase10_default_edge_confidence row in the tracker.
    const rows = Array.from(migrationRepo.rows.values()) as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    expect(names.filter((n) => n === 'phase10_default_edge_confidence')).toHaveLength(1);
  });

  it('is a no-op on a second run (idempotent)', async () => {
    await service.runPending();
    const writesAfterFirst = memgraph.writes.length;

    const ran = await service.runPending();
    expect(ran).toEqual([]);
    expect(memgraph.writes.length).toBe(writesAfterFirst);
  });

  it('GRAPH_MIGRATIONS catalog includes phase10_default_edge_confidence', () => {
    const names = GRAPH_MIGRATIONS.map((m) => m.name);
    expect(names).toContain('phase10_default_edge_confidence');
  });
});
