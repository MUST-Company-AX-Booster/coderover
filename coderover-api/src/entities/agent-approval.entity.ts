import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { AgentRun } from './agent-run.entity';

export enum AgentApprovalStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  EXPIRED = 'expired',
}

@Entity('agent_approvals')
export class AgentApproval {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => AgentRun, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'agent_run_id' })
  agentRun!: AgentRun;

  @Column({ name: 'agent_run_id' })
  agentRunId!: string;

  @Column({ name: 'action_type', type: 'varchar' })
  actionType!: string;

  @Column({ name: 'action_payload', type: 'jsonb' })
  actionPayload!: Record<string, any>;

  @Column({
    type: 'enum',
    enum: AgentApprovalStatus,
    default: AgentApprovalStatus.PENDING,
  })
  status!: AgentApprovalStatus;

  @Column({ name: 'approval_token', type: 'varchar', unique: true })
  approvalToken!: string;

  @Column({ name: 'approver', type: 'varchar', nullable: true })
  approver!: string;

  @Column({ name: 'decided_at', type: 'timestamp', nullable: true })
  decidedAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamp' })
  expiresAt!: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
