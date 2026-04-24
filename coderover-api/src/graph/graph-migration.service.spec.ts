import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { GraphMigrationService, GRAPH_MIGRATIONS } from './graph-migration.service';
import { MemgraphService } from './memgraph.service';
import { GraphMigration } from '../entities/graph-migration.entity';

describe('GraphMigrationService', () => {
  let service: GraphMigrationService;
  let repo: any;
  let memgraph: any;

  beforeEach(async () => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockResolvedValue(undefined),
    };
    memgraph = {
      // Default: read queries return empty arrays so ID-backfill walks
      // zero rows. Tests that exercise the backfill override per-call.
      readQuery: jest.fn().mockResolvedValue([]),
      writeQuery: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GraphMigrationService,
        { provide: getRepositoryToken(GraphMigration), useValue: repo },
        { provide: MemgraphService, useValue: memgraph },
      ],
    }).compile();

    service = module.get(GraphMigrationService);
  });

  it('applies all pending migrations and records them', async () => {
    const ran = await service.runPending();

    expect(ran).toEqual(GRAPH_MIGRATIONS.map((m) => m.name));
    // At least one writeQuery per pending migration (deterministic-ids
    // issues zero extra writes when the backfill reads come back empty).
    expect(memgraph.writeQuery).toHaveBeenCalled();
    expect(memgraph.writeQuery.mock.calls.length).toBeGreaterThanOrEqual(
      GRAPH_MIGRATIONS.length - 1,
    );
    expect(repo.insert).toHaveBeenCalledTimes(GRAPH_MIGRATIONS.length);
    for (const step of GRAPH_MIGRATIONS) {
      expect(repo.insert).toHaveBeenCalledWith({ name: step.name });
    }
  });

  it('is a no-op when every migration is already recorded', async () => {
    repo.find.mockResolvedValueOnce(
      GRAPH_MIGRATIONS.map((m) => ({ name: m.name, appliedAt: new Date() })),
    );

    const ran = await service.runPending();

    expect(ran).toEqual([]);
    expect(memgraph.writeQuery).not.toHaveBeenCalled();
    expect(memgraph.readQuery).not.toHaveBeenCalled();
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('only runs steps not yet recorded', async () => {
    repo.find.mockResolvedValueOnce([
      { name: GRAPH_MIGRATIONS[0].name, appliedAt: new Date() },
    ]);

    const ran = await service.runPending();

    const expectedRemaining = GRAPH_MIGRATIONS.slice(1).map((m) => m.name);
    expect(ran).toEqual(expectedRemaining);
    // Remaining migrations all ran at least their read/setup pass.
    expect(repo.insert).toHaveBeenCalledTimes(expectedRemaining.length);
  });

  describe('phase10_default_edge_confidence migration', () => {
    const step = GRAPH_MIGRATIONS.find((m) => m.name === 'phase10_default_edge_confidence');

    it('is registered', () => {
      expect(step).toBeDefined();
    });

    it('writes a Cypher query that only matches edges without confidence', async () => {
      const memgraphStub = {
        readQuery: jest.fn().mockResolvedValue([]),
        writeQuery: jest.fn().mockResolvedValue([]),
      };
      await step!.run(memgraphStub as any);
      const [cypher] = memgraphStub.writeQuery.mock.calls[0];
      expect(cypher).toMatch(/e\.confidence IS NULL/);
      expect(cypher).toMatch(/SET e\.confidence = 'AMBIGUOUS'/);
      expect(cypher).toMatch(/CALLS.*IMPORTS.*INHERITS.*DEFINES/s);
    });
  });

  describe('phase10_c2_deterministic_ids migration', () => {
    const step = GRAPH_MIGRATIONS.find(
      (m) => m.name === 'phase10_c2_deterministic_ids',
    );

    it('is registered', () => {
      expect(step).toBeDefined();
    });

    it('walks nodes missing node_id and back-fills them', async () => {
      // Neo4j records expose fields via .get(name). Build tiny stand-ins.
      const rec = (obj: Record<string, unknown>) => ({
        get: (k: string) => obj[k],
      });

      const memgraphStub: any = {
        readQuery: jest
          .fn()
          // First call: node backfill query.
          .mockResolvedValueOnce([
            rec({
              internalId: 1,
              labels: ['File'],
              filePath: 'src/foo.ts',
              name: '',
              kind: '',
              className: '',
            }),
            rec({
              internalId: 2,
              labels: ['Function'],
              filePath: 'src/foo.ts',
              name: 'bar',
              kind: 'function',
              className: '',
            }),
          ])
          // Second call: edge backfill query.
          .mockResolvedValueOnce([
            rec({
              edgeInternalId: 11,
              kind: 'CALLS',
              srcId: 'aaaa1111bbbb2222',
              dstId: 'cccc3333dddd4444',
            }),
          ]),
        writeQuery: jest.fn().mockResolvedValue([]),
      };

      await step!.run(memgraphStub);

      // Two nodes ⇒ two node-backfill writes; one edge ⇒ one edge-backfill write.
      expect(memgraphStub.writeQuery).toHaveBeenCalledTimes(3);

      const nodeCyphers = memgraphStub.writeQuery.mock.calls
        .map((c: any[]) => c[0] as string)
        .filter((c: string) => c.includes('n.node_id'));
      expect(nodeCyphers.length).toBe(2);
      for (const c of nodeCyphers) {
        expect(c).toMatch(/n\.node_id IS NULL/);
        expect(c).toMatch(/SET n\.node_id/);
      }

      const edgeCyphers = memgraphStub.writeQuery.mock.calls
        .map((c: any[]) => c[0] as string)
        .filter((c: string) => c.includes('e.edge_id'));
      expect(edgeCyphers.length).toBe(1);
      expect(edgeCyphers[0]).toMatch(/e\.edge_id IS NULL/);
      expect(edgeCyphers[0]).toMatch(/SET e\.edge_id/);
    });

    it('is a no-op when nothing is missing its ID', async () => {
      const memgraphStub: any = {
        readQuery: jest.fn().mockResolvedValue([]),
        writeQuery: jest.fn().mockResolvedValue([]),
      };
      await step!.run(memgraphStub);
      expect(memgraphStub.writeQuery).not.toHaveBeenCalled();
    });

    it('filters the edge-backfill read to supported relation kinds', async () => {
      const memgraphStub: any = {
        readQuery: jest.fn().mockResolvedValue([]),
        writeQuery: jest.fn().mockResolvedValue([]),
      };
      await step!.run(memgraphStub);
      // Two reads issued: nodes, then edges.
      expect(memgraphStub.readQuery).toHaveBeenCalledTimes(2);
      const [, edgeReadCypher] = memgraphStub.readQuery.mock.calls.map(
        (c: any[]) => c[0] as string,
      );
      expect(edgeReadCypher).toMatch(/CALLS.*IMPORTS.*INHERITS.*DEFINES/s);
      expect(edgeReadCypher).toMatch(/e\.edge_id IS NULL/);
    });
  });
});
