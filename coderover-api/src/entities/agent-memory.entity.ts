import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Repo } from './repo.entity';

export enum AgentMemoryType {
  DISMISSED = 'dismissed',
  APPROVED_PATTERN = 'approved_pattern',
  PREFERENCE = 'preference',
  DECISION = 'decision',
}

@Entity('agent_memory')
export class AgentMemory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Repo, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo!: Repo;

  @Column({ name: 'repo_id' })
  repoId!: string;

  @Column({
    type: 'enum',
    enum: AgentMemoryType,
    name: 'memory_type',
  })
  memoryType!: AgentMemoryType;

  @Column({ name: 'key', type: 'varchar' })
  key!: string;

  @Column({ name: 'value', type: 'jsonb' })
  value!: Record<string, any>;

  @Column({ name: 'expires_at', type: 'timestamp', nullable: true })
  expiresAt!: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
