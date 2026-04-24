import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemgraphService } from './memgraph.service';
import { GraphMigration } from '../entities/graph-migration.entity';
import { computeEdgeId, computeNodeId } from './deterministic-ids';

export interface GraphMigrationStep {
  name: string;
  run(memgraph: MemgraphService): Promise<void>;
}

/**
 * Phase 10 B1 migration — set `confidence = 'AMBIGUOUS'` on every pre-existing
 * graph edge that has no confidence property. Idempotent: the WHERE clause
 * only matches edges where the property is absent, so re-runs are safe.
 *
 * After B2 producers land, each new edge will be written with confidence set
 * explicitly by `ConfidenceTagger` — this migration only back-fills the prior era.
 */
const PHASE10_DEFAULT_EDGE_CONFIDENCE: GraphMigrationStep = {
  name: 'phase10_default_edge_confidence',
  async run(memgraph: MemgraphService): Promise<void> {
    await memgraph.writeQuery(`
      MATCH ()-[e]->()
      WHERE type(e) IN ['CALLS', 'IMPORTS', 'INHERITS', 'DEFINES']
        AND e.confidence IS NULL
      SET e.confidence = 'AMBIGUOUS'
    `);
  },
};

/**
 * Phase 10 C2 — backfill `node_id` / `edge_id` on every pre-existing entity.
 *
 * New writes always carry IDs (see `graph.service.ts`), but repos that
 * were ingested before C2 have `node_id IS NULL`. Incremental ingest
 * (`incremental-ingest.service.ts`) keys orphan cleanup off `node_id`,
 * so any node without one is invisible to the delta pass. This step
 * closes that window.
 *
 * Idempotent: the WHERE clause only matches entities missing the
 * property, so re-runs skip everything.
 *
 * Formulas MUST match `src/graph/deterministic-ids.ts` (SHA256 of the
 * tuple joined by the unit-separator `\x1f`, truncated to 16 hex chars).
 * Cypher has no SHA256 primitive, so we stream each row back through
 * the Node-side helper and write back its ID. That's one round-trip
 * per entity; for repos with <100k entities that's seconds, which is
 * acceptable for a one-time migration.
 */
const PHASE10_C2_DETERMINISTIC_IDS: GraphMigrationStep = {
  name: 'phase10_c2_deterministic_ids',
  async run(memgraph: MemgraphService): Promise<void> {
    // Node backfill.
    // We read `filePath`, `kind`/`className`/`name` (whichever applies) and
    // synthesize a qualifiedName per label so the ID matches what future
    // writes will produce.
    const nodeRows = await memgraph.readQuery(`
      MATCH (n)
      WHERE (n:File OR n:Symbol OR n:Function OR n:Method OR n:Class)
        AND n.node_id IS NULL
      RETURN
        id(n) AS internalId,
        labels(n) AS labels,
        coalesce(n.filePath, '') AS filePath,
        coalesce(n.name, '') AS name,
        coalesce(n.kind, '') AS kind,
        coalesce(n.className, '') AS className
    `);

    for (const rec of nodeRows) {
      const labels: string[] = rec.get('labels');
      const filePath: string = rec.get('filePath');
      const name: string = rec.get('name');
      const kind: string = rec.get('kind');
      const className: string = rec.get('className');
      const { symbolKind, qualifiedName } = deriveIdentity(labels, {
        name,
        kind,
        className,
        filePath,
      });
      const nodeId = computeNodeId(filePath, symbolKind, qualifiedName);
      await memgraph.writeQuery(
        `
        MATCH (n) WHERE id(n) = $internalId AND n.node_id IS NULL
        SET n.node_id = $nodeId
        `,
        { internalId: rec.get('internalId'), nodeId },
      );
    }

    // Edge backfill: for every supported relation kind, set edge_id from
    // the endpoint node_ids + relation type. Endpoints must have node_id
    // first, which the node pass above guarantees.
    const edgeRows = await memgraph.readQuery(`
      MATCH (s)-[e]->(t)
      WHERE type(e) IN ['CALLS', 'IMPORTS', 'INHERITS', 'DEFINES']
        AND e.edge_id IS NULL
        AND s.node_id IS NOT NULL
        AND t.node_id IS NOT NULL
      RETURN id(e) AS edgeInternalId,
             type(e) AS kind,
             s.node_id AS srcId,
             t.node_id AS dstId
    `);

    for (const rec of edgeRows) {
      const kind: string = rec.get('kind');
      const srcId: string = rec.get('srcId');
      const dstId: string = rec.get('dstId');
      const edgeId = computeEdgeId(srcId, dstId, kind);
      await memgraph.writeQuery(
        `
        MATCH ()-[e]->() WHERE id(e) = $edgeInternalId AND e.edge_id IS NULL
        SET e.edge_id = $edgeId
        `,
        { edgeInternalId: rec.get('edgeInternalId'), edgeId },
      );
    }
  },
};

/**
 * Pick a sensible `(symbolKind, qualifiedName)` for a legacy node based
 * on its labels and properties. Must match the identity that
 * `graph.service.ts` uses on fresh writes, or backfilled IDs won't
 * equal the IDs of re-ingested entities after C2.
 */
function deriveIdentity(
  labels: string[],
  props: { name: string; kind: string; className: string; filePath: string },
): { symbolKind: string; qualifiedName: string } {
  const set = new Set(labels);
  if (set.has('File')) {
    return { symbolKind: 'file', qualifiedName: props.filePath };
  }
  if (set.has('Method')) {
    const qn = props.className ? `${props.className}.${props.name}` : props.name;
    return { symbolKind: 'method', qualifiedName: qn };
  }
  if (set.has('Class')) {
    return { symbolKind: 'class', qualifiedName: props.name };
  }
  if (set.has('Function')) {
    return { symbolKind: 'function', qualifiedName: props.name };
  }
  // Generic Symbol — use its own `kind` prop if present.
  return {
    symbolKind: props.kind || 'symbol',
    qualifiedName: props.name,
  };
}

export const GRAPH_MIGRATIONS: GraphMigrationStep[] = [
  PHASE10_DEFAULT_EDGE_CONFIDENCE,
  PHASE10_C2_DETERMINISTIC_IDS,
];

/**
 * Applies Memgraph-level Cypher migrations exactly once per deployment.
 *
 * Memgraph has no native schema versioning, so we track applied migrations
 * in Postgres (`graph_migrations`). On application bootstrap, any step whose
 * name is absent from the tracker table runs and is recorded.
 *
 * Gated by `GRAPH_MIGRATIONS_RUN=true` (mirrors `TYPEORM_MIGRATIONS_RUN`).
 * Tests call `runPending()` directly and skip the gate.
 */
@Injectable()
export class GraphMigrationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(GraphMigrationService.name);

  constructor(
    @InjectRepository(GraphMigration)
    private readonly repo: Repository<GraphMigration>,
    private readonly memgraph: MemgraphService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.GRAPH_MIGRATIONS_RUN !== 'true') return;
    try {
      const applied = await this.runPending();
      if (applied.length > 0) {
        this.logger.log(`Applied ${applied.length} graph migration(s): ${applied.join(', ')}`);
      }
    } catch (err) {
      this.logger.error('Graph migrations failed on bootstrap', err as Error);
    }
  }

  async runPending(): Promise<string[]> {
    const existing = await this.repo.find();
    const applied = new Set(existing.map((r) => r.name));
    const ran: string[] = [];

    for (const step of GRAPH_MIGRATIONS) {
      if (applied.has(step.name)) continue;
      await step.run(this.memgraph);
      await this.repo.insert({ name: step.name });
      ran.push(step.name);
    }

    return ran;
  }
}
