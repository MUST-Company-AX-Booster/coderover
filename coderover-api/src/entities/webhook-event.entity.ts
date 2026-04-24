import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('webhook_events')
export class WebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'event_type' })
  eventType!: string; // 'push' | 'pull_request' | 'ping' | ...

  @Column({ type: 'text', nullable: true })
  action!: string | null; // 'opened' | 'synchronize' | 'closed' | ...

  @Column()
  repo!: string; // 'owner/name'

  @Column({ type: 'text', nullable: true })
  ref!: string | null; // 'refs/heads/main'

  @Column({ name: 'commit_sha', type: 'text', nullable: true })
  commitSha!: string | null;

  @Column({ name: 'pr_number', type: 'int', nullable: true })
  prNumber!: number | null;

  @Column({ type: 'text', nullable: true })
  sender!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  payload!: any;

  @Column({ default: false })
  processed!: boolean;

  @Column({ name: 'processed_by_agent', default: false })
  processedByAgent!: boolean;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
