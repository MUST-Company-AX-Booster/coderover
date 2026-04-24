import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Repo } from './repo.entity';

export enum AgentRuleSeverity {
  CRITICAL = 'critical',
  WARNING = 'warning',
  INFO = 'info',
}

@Entity('agent_rules')
export class AgentRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Repo, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'repo_id' })
  repo!: Repo;

  @Column({ name: 'repo_id', nullable: true })
  repoId!: string;

  @Column({ name: 'name', type: 'varchar' })
  name!: string;

  @Column({ name: 'description', type: 'text' })
  description!: string;

  @Column({ name: 'detection_pattern', type: 'jsonb' })
  detectionPattern!: Record<string, any>;

  @Column({
    type: 'enum',
    enum: AgentRuleSeverity,
    default: AgentRuleSeverity.WARNING,
  })
  severity!: AgentRuleSeverity;

  @Column({ name: 'auto_fix_template', type: 'text', nullable: true })
  autoFixTemplate!: string;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
