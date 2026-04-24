import { Entity, PrimaryGeneratedColumn, Column, UpdateDateColumn } from 'typeorm';

@Entity('sync_log')
export class SyncLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  repo!: string;

  @Column({ name: 'repo_id', nullable: true })
  repoId!: string;

  @Column({ name: 'last_commit_sha', nullable: true })
  lastCommitSha!: string;

  @Column({ name: 'files_indexed', default: 0 })
  filesIndexed!: number;

  @Column({ name: 'chunks_total', default: 0 })
  chunksTotal!: number;

  @UpdateDateColumn({ name: 'synced_at' })
  syncedAt!: Date;
}
