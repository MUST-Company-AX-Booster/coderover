import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { PrReview } from './pr-review.entity';
import type { ConfidenceTag } from './rag-citation.entity';

export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical';
export type FindingCategory =
  | 'security'
  | 'performance'
  | 'correctness'
  | 'style'
  | 'maintainability';

@Entity('pr_review_findings')
export class PrReviewFinding {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => PrReview, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'pr_review_id' })
  prReview!: PrReview;

  @Index('idx_pr_review_findings_pr_review_id')
  @Column({ name: 'pr_review_id', type: 'uuid' })
  prReviewId!: string;

  @Index('idx_pr_review_findings_org_id')
  @Column({ name: 'org_id', type: 'uuid', nullable: true })
  orgId!: string | null;

  @Column({ type: 'text', nullable: true })
  file!: string | null;

  @Column({ type: 'int', nullable: true })
  line!: number | null;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'text' })
  severity!: FindingSeverity;

  @Column({ type: 'text' })
  category!: FindingCategory;

  @Index('idx_pr_review_findings_confidence')
  @Column({ type: 'enum', enum: ['EXTRACTED', 'INFERRED', 'AMBIGUOUS'], default: 'AMBIGUOUS' })
  confidence!: ConfidenceTag;

  @Column({ name: 'confidence_score', type: 'double precision', nullable: true })
  confidenceScore!: number | null;

  @Column({ name: 'evidence_ref', type: 'jsonb', nullable: true })
  evidenceRef!: any;

  @Column({ type: 'text', nullable: true })
  producer!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
