import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import type { ConfidenceTag } from './rag-citation.entity';

/**
 * Phase 10 B1 — Edge producer audit log.
 *
 * Every write to a Memgraph edge (CALLS / IMPORTS / INHERITS / DEFINES) by a
 * producer (AST resolver, LLM, grep, etc.) inserts a row here. The background
 * `ConfidenceRetagJob` reads these rows to promote `AMBIGUOUS` edges and
 * citations to `EXTRACTED` or `INFERRED`.
 *
 * `edge_id` is a TEXT deterministic hash (see C2-bis in Phase10 plan):
 *   edge_id = hash(src_id + dst_id + relation_kind)
 *
 * `producer_kind` is the classification assigned by `ConfidenceTagger`,
 * never a free-form label — enforced by the `confidence_tag` enum.
 */
@Entity('edge_producer_audit')
export class EdgeProducerAudit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_edge_producer_audit_edge_id')
  @Column({ name: 'edge_id', type: 'text' })
  edgeId!: string;

  @Column({ name: 'relation_kind', type: 'text' })
  relationKind!: string;

  @Column({ type: 'text' })
  producer!: string;

  @Column({
    name: 'producer_kind',
    type: 'enum',
    enum: ['EXTRACTED', 'INFERRED', 'AMBIGUOUS'],
  })
  producerKind!: ConfidenceTag;

  @Column({ name: 'producer_confidence', type: 'double precision', nullable: true })
  producerConfidence!: number | null;

  @Index('idx_edge_producer_audit_org_id')
  @Column({ name: 'org_id', type: 'uuid', nullable: true })
  orgId!: string | null;

  @Column({ name: 'evidence_ref', type: 'jsonb', nullable: true })
  evidenceRef!: any;

  @Index('idx_edge_producer_audit_created_at')
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
