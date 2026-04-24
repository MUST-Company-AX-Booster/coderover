import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('pr_reviews')
export class PrReview {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'pr_number' })
  prNumber!: number;

  @Column()
  repo!: string;

  @Column({ nullable: true, name: 'repo_id', type: 'text' })
  repoId!: string | null;

  @Column({ default: 'pending' })
  status!: string; // 'pending' | 'in_progress' | 'completed' | 'failed'

  @Column({ name: 'diff_summary', type: 'text', nullable: true })
  diffSummary!: string;

  @Column({ type: 'jsonb', nullable: true })
  findings!: any;

  @Column({ name: 'github_comment_id', type: 'bigint', nullable: true })
  githubCommentId!: string | null;

  @Column({ name: 'review_url', type: 'text', nullable: true })
  reviewUrl!: string | null;

  @Column({ name: 'ai_model', type: 'text', nullable: true })
  aiModel!: string | null;

  @Column({ name: 'llm_latency_ms', type: 'int', nullable: true })
  llmLatencyMs!: number | null;

  @Column({ name: 'llm_duration_ms', type: 'int', nullable: true })
  llmDurationMs!: number | null;

  @Column({ name: 'prompt_tokens', type: 'int', nullable: true })
  promptTokens!: number | null;

  @Column({ name: 'completion_tokens', type: 'int', nullable: true })
  completionTokens!: number | null;

  @Column({ name: 'total_tokens', type: 'int', nullable: true })
  totalTokens!: number | null;

  @Column({ name: 'posted_at', nullable: true })
  postedAt!: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  /** Phase 9: owning organization. Nullable during rollout. */
  @Column({ name: 'org_id', type: 'uuid', nullable: true })
  orgId!: string | null;
}
