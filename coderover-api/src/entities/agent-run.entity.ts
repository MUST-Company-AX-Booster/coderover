import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Repo } from './repo.entity';

export enum AgentType {
  PR_REVIEW = 'pr_review',
  REFACTOR = 'refactor',
  ENFORCER = 'enforcer',
  HEALTH_CHECK = 'health_check',
  ORCHESTRATOR = 'orchestrator',
}

export enum AgentRunStatus {
  QUEUED = 'queued',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum AgentTrigger {
  WEBHOOK = 'webhook',
  CRON = 'cron',
  MANUAL = 'manual',
}

@Entity('agent_runs')
export class AgentRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Repo, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo!: Repo;

  @Column({ name: 'repo_id' })
  repoId!: string;

  @Column({
    type: 'enum',
    enum: AgentType,
    name: 'agent_type',
  })
  agentType!: AgentType;

  @Column({
    type: 'enum',
    enum: AgentRunStatus,
    default: AgentRunStatus.QUEUED,
  })
  status!: AgentRunStatus;

  @Column({
    type: 'enum',
    enum: AgentTrigger,
  })
  trigger!: AgentTrigger;

  @Column({ name: 'started_at', type: 'timestamp', nullable: true })
  startedAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamp', nullable: true })
  completedAt!: Date;

  @Column({ name: 'llm_tokens_used', type: 'int', default: 0 })
  llmTokensUsed!: number;

  @Column({ name: 'findings_count', type: 'int', default: 0 })
  findingsCount!: number;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, any>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  /** Phase 9: owning organization. Nullable during rollout. */
  @Column({ name: 'org_id', type: 'uuid', nullable: true })
  orgId!: string | null;
}
