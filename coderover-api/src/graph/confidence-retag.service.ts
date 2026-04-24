import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemgraphService } from './memgraph.service';
import { EdgeProducerAudit } from '../entities/edge-producer-audit.entity';
import type { ConfidenceTag } from '../entities/rag-citation.entity';

export interface RetagBatchResult {
  auditRowsScanned: number;
  edgesUpdated: number;
  edgesSkipped: number;
  batches: number;
}

export interface RetagOptions {
  /** Max audit rows pulled per batch. Default 500. */
  batchSize?: number;
  /** Hard cap on total edges updated in a single run. Default 10_000. */
  maxUpdates?: number;
  /** If true, does not actually write to Memgraph. Used by tests / dry-runs. */
  dryRun?: boolean;
}

/**
 * Phase 10 B1 — Background confidence re-tag job.
 *
 * Reads `edge_producer_audit` in batches (keyed by edge_id), picks the
 * highest-authority producer classification per edge, and sets the edge's
 * `confidence` + `confidence_score` properties in Memgraph. Promotes rows
 * from the initial `AMBIGUOUS` default to `EXTRACTED` or `INFERRED`.
 *
 * Authority order (when a single edge has multiple audit rows):
 *   `EXTRACTED` > `INFERRED` > `AMBIGUOUS`
 *
 * Idempotent: re-running the same audit data produces the same result. Rows
 * whose `edge_id` is not yet present on any Memgraph edge are counted as
 * skipped — they'll promote on the next run after B2/C2 wires edge_id.
 *
 * The job does **not** consume its own token bucket yet; that lands with B2
 * when producers populate the audit table in production. Until then, this is
 * the scaffolding that guarantees correctness on the AMBIGUOUS defaults
 * (critical-gap test #6).
 */
@Injectable()
export class ConfidenceRetagService {
  private readonly logger = new Logger(ConfidenceRetagService.name);

  constructor(
    @InjectRepository(EdgeProducerAudit)
    private readonly auditRepo: Repository<EdgeProducerAudit>,
    private readonly memgraph: MemgraphService,
  ) {}

  async run(options: RetagOptions = {}): Promise<RetagBatchResult> {
    const batchSize = options.batchSize ?? 500;
    const maxUpdates = options.maxUpdates ?? 10_000;

    let scanned = 0;
    let updated = 0;
    let skipped = 0;
    let batches = 0;
    let offset = 0;

    while (updated < maxUpdates) {
      const audits = await this.auditRepo
        .createQueryBuilder('a')
        .orderBy('a.edge_id', 'ASC')
        .addOrderBy('a.created_at', 'ASC')
        .skip(offset)
        .take(batchSize)
        .getMany();

      if (audits.length === 0) break;

      batches += 1;
      scanned += audits.length;
      offset += audits.length;

      const winners = this.pickWinnersPerEdge(audits);
      for (const winner of winners.values()) {
        if (updated >= maxUpdates) break;
        const ok = await this.applyToMemgraph(winner, options.dryRun === true);
        if (ok) updated += 1;
        else skipped += 1;
      }
    }

    this.logger.log(
      `retag complete: scanned=${scanned} updated=${updated} skipped=${skipped} batches=${batches}`,
    );
    return { auditRowsScanned: scanned, edgesUpdated: updated, edgesSkipped: skipped, batches };
  }

  private pickWinnersPerEdge(audits: EdgeProducerAudit[]): Map<string, EdgeProducerAudit> {
    const byEdge = new Map<string, EdgeProducerAudit>();
    for (const a of audits) {
      const existing = byEdge.get(a.edgeId);
      if (!existing || authorityRank(a.producerKind) > authorityRank(existing.producerKind)) {
        byEdge.set(a.edgeId, a);
      }
    }
    return byEdge;
  }

  private async applyToMemgraph(audit: EdgeProducerAudit, dryRun: boolean): Promise<boolean> {
    if (dryRun) return true;
    const result = await this.memgraph.writeQuery(
      `
      MATCH ()-[e]->()
      WHERE e.edge_id = $edgeId
      SET e.confidence = $kind,
          e.confidence_score = $score
      RETURN count(e) AS updated
      `,
      {
        edgeId: audit.edgeId,
        kind: audit.producerKind,
        score: audit.producerConfidence,
      },
    );
    const count = result[0]?.get('updated');
    const n = typeof count === 'number' ? count : Number(count?.toNumber?.() ?? 0);
    return n > 0;
  }
}

function authorityRank(tag: ConfidenceTag): number {
  switch (tag) {
    case 'EXTRACTED':
      return 2;
    case 'INFERRED':
      return 1;
    default:
      return 0;
  }
}
