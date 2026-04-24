import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { RagCitation } from '../entities/rag-citation.entity';
import { PrReviewFinding } from '../entities/pr-review-finding.entity';
import { EdgeProducerAudit } from '../entities/edge-producer-audit.entity';
import type { ConfidenceTag } from '../entities/rag-citation.entity';

/**
 * Phase 10 B4 — "Why this?" evidence trail per citation / finding.
 *
 * Shape is deliberately uniform across citations and findings so the UI can
 * render a single accordion component. `kind: 'not_found'` preserves caller
 * ordering even when an id is missing or belongs to another org — the
 * alternative (404-the-whole-batch) would force clients back into N+1
 * per-id GETs, which is exactly what this endpoint exists to prevent.
 */
export type EvidenceKind = 'citation' | 'finding' | 'not_found';

export interface UpstreamAudit {
  producer: string;
  producer_kind: string;
  producer_confidence: number | null;
  created_at: string;
}

export interface SimilarCitation {
  id: string;
  file_path: string;
  similarity: number | null;
}

export interface EvidenceResult {
  id: string;
  kind: EvidenceKind;
  tag: ConfidenceTag | null;
  score: number | null;
  producer: string | null;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  evidence: {
    upstream_audits: UpstreamAudit[];
    similar_citations: SimilarCitation[];
    raw_ref: any;
  } | null;
}

/** Similar-citations cap. Keeps the payload bounded on file_paths with
 *  hundreds of citations; the UI only shows the first handful anyway. */
const SIMILAR_CITATIONS_LIMIT = 3;

@Injectable()
export class CitationsService {
  private readonly logger = new Logger(CitationsService.name);

  constructor(
    @InjectRepository(RagCitation)
    private readonly ragCitationRepo: Repository<RagCitation>,
    @InjectRepository(PrReviewFinding)
    private readonly prFindingRepo: Repository<PrReviewFinding>,
    @InjectRepository(EdgeProducerAudit)
    private readonly edgeAuditRepo: Repository<EdgeProducerAudit>,
  ) {}

  /**
   * Fetch evidence for a batch of citation/finding ids.
   *
   * Two id-resolution queries run in parallel (one per table). Missing ids
   * (not present in either table, or belonging to another org) come back as
   * `kind: 'not_found'` with a null tag. Cross-org ids are indistinguishable
   * from genuinely-missing ids by design — leaking "this id exists, just
   * not for you" would be a cross-tenant probe.
   *
   * Results are returned in the caller's input order (after deduplication).
   */
  async getBatchEvidence(
    ids: string[],
    orgId: string,
  ): Promise<EvidenceResult[]> {
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id);
        deduped.push(id);
      }
    }

    if (deduped.length === 0) return [];

    // Two parallel id-resolution queries — one per table. Org-scoped; rows
    // belonging to another org simply don't come back.
    const [citations, findings] = await Promise.all([
      this.ragCitationRepo.find({
        where: { id: In(deduped), orgId },
      }),
      this.prFindingRepo.find({
        where: { id: In(deduped), orgId },
      }),
    ]);

    const citationById = new Map(citations.map((c) => [c.id, c]));
    const findingById = new Map(findings.map((f) => [f.id, f]));

    // Collect unique edge_ids referenced by evidence_ref across both sets
    // so we can batch the audit lookup. Evidence-ref is jsonb; we accept
    // either `{ edge_id: '...' }` (B2 producers) or a bare string fallback.
    const edgeIds = new Set<string>();
    const extractEdgeId = (ref: any): string | null => {
      if (!ref) return null;
      if (typeof ref === 'string') return ref;
      if (typeof ref === 'object' && typeof ref.edge_id === 'string') {
        return ref.edge_id;
      }
      return null;
    };
    for (const c of citations) {
      const eid = extractEdgeId(c.evidenceRef);
      if (eid) edgeIds.add(eid);
    }
    for (const f of findings) {
      const eid = extractEdgeId(f.evidenceRef);
      if (eid) edgeIds.add(eid);
    }

    // Batch-load audits for every referenced edge_id. One query regardless
    // of how many edges the batch touches.
    const auditsByEdgeId = new Map<string, EdgeProducerAudit[]>();
    if (edgeIds.size > 0) {
      const audits = await this.edgeAuditRepo.find({
        where: { edgeId: In([...edgeIds]) },
        order: { createdAt: 'DESC' },
      });
      for (const a of audits) {
        const arr = auditsByEdgeId.get(a.edgeId) ?? [];
        arr.push(a);
        auditsByEdgeId.set(a.edgeId, arr);
      }
    }

    // Batch-load similar citations: for each distinct file_path referenced
    // by a citation or finding in this batch, fetch up to
    // SIMILAR_CITATIONS_LIMIT + <source-count> rows in one query, then
    // filter out the source ids and trim to the limit per file_path.
    const filePaths = new Set<string>();
    for (const c of citations) if (c.filePath) filePaths.add(c.filePath);
    for (const f of findings) if (f.file) filePaths.add(f.file);

    const similarByFilePath = new Map<string, SimilarCitation[]>();
    if (filePaths.size > 0) {
      // Over-fetch a little per file_path so we can still return 3 after
      // excluding the source rows. A file_path with N source ids needs
      // LIMIT + N rows to guarantee LIMIT after exclusion.
      const ragIdsInBatch = new Set(citations.map((c) => c.id));
      const overfetchIds = Array.from(ragIdsInBatch);
      const similarRows = await this.ragCitationRepo.find({
        where: {
          orgId,
          filePath: In([...filePaths]),
          ...(overfetchIds.length > 0 ? { id: Not(In(overfetchIds)) } : {}),
        },
        select: ['id', 'filePath', 'similarity'],
        order: { similarity: 'DESC', createdAt: 'DESC' },
        // Upper bound on rows returned from the DB. Prevents pathological
        // file_paths (thousands of citations in one file) from blowing the
        // response up — we'll trim to SIMILAR_CITATIONS_LIMIT per file
        // below.
        take: SIMILAR_CITATIONS_LIMIT * filePaths.size * 4,
      });
      for (const row of similarRows) {
        const existing = similarByFilePath.get(row.filePath) ?? [];
        if (existing.length < SIMILAR_CITATIONS_LIMIT) {
          existing.push({
            id: row.id,
            file_path: row.filePath,
            similarity: row.similarity,
          });
          similarByFilePath.set(row.filePath, existing);
        }
      }
    }

    // Assemble per-id results in input order.
    return deduped.map((id): EvidenceResult => {
      const citation = citationById.get(id);
      if (citation) {
        return this.buildCitationResult(citation, auditsByEdgeId, similarByFilePath);
      }
      const finding = findingById.get(id);
      if (finding) {
        return this.buildFindingResult(finding, auditsByEdgeId, similarByFilePath);
      }
      return {
        id,
        kind: 'not_found',
        tag: null,
        score: null,
        producer: null,
        file_path: null,
        line_start: null,
        line_end: null,
        evidence: null,
      };
    });
  }

  private buildCitationResult(
    c: RagCitation,
    auditsByEdgeId: Map<string, EdgeProducerAudit[]>,
    similarByFilePath: Map<string, SimilarCitation[]>,
  ): EvidenceResult {
    const edgeId = this.extractEdgeId(c.evidenceRef);
    const audits = edgeId ? auditsByEdgeId.get(edgeId) ?? [] : [];
    const similar = (similarByFilePath.get(c.filePath) ?? []).filter(
      (s) => s.id !== c.id,
    );
    return {
      id: c.id,
      kind: 'citation',
      tag: c.confidence,
      score: c.confidenceScore,
      producer: c.producer,
      file_path: c.filePath,
      line_start: c.lineStart,
      line_end: c.lineEnd,
      evidence: {
        upstream_audits: audits.map(auditToDto),
        similar_citations: similar,
        raw_ref: c.evidenceRef ?? null,
      },
    };
  }

  private buildFindingResult(
    f: PrReviewFinding,
    auditsByEdgeId: Map<string, EdgeProducerAudit[]>,
    similarByFilePath: Map<string, SimilarCitation[]>,
  ): EvidenceResult {
    const edgeId = this.extractEdgeId(f.evidenceRef);
    const audits = edgeId ? auditsByEdgeId.get(edgeId) ?? [] : [];
    const similar = f.file
      ? (similarByFilePath.get(f.file) ?? []).filter((s) => s.id !== f.id)
      : [];
    return {
      id: f.id,
      kind: 'finding',
      tag: f.confidence,
      score: f.confidenceScore,
      producer: f.producer,
      file_path: f.file,
      line_start: f.line,
      line_end: f.line,
      evidence: {
        upstream_audits: audits.map(auditToDto),
        similar_citations: similar,
        raw_ref: f.evidenceRef ?? null,
      },
    };
  }

  private extractEdgeId(ref: any): string | null {
    if (!ref) return null;
    if (typeof ref === 'string') return ref;
    if (typeof ref === 'object' && typeof ref.edge_id === 'string') {
      return ref.edge_id;
    }
    return null;
  }
}

function auditToDto(a: EdgeProducerAudit): UpstreamAudit {
  return {
    producer: a.producer,
    producer_kind: a.producerKind,
    producer_confidence: a.producerConfidence,
    created_at:
      a.createdAt instanceof Date ? a.createdAt.toISOString() : String(a.createdAt),
  };
}
