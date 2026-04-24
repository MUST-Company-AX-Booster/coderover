import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export type ArtifactType = 'schema' | 'openapi' | 'terraform' | 'markdown' | 'graphql' | 'proto';

@Entity('context_artifacts')
export class ContextArtifact {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'repo_id', type: 'uuid', nullable: true })
  repoId!: string | null;

  @Column({ name: 'artifact_type', type: 'text' })
  artifactType!: ArtifactType;

  @Column({ name: 'file_path', type: 'text' })
  filePath!: string;

  @Column({ name: 'content', type: 'text' })
  content!: string;

  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata!: Record<string, any> | null;

  @Column({ name: 'commit_sha', type: 'text', nullable: true })
  commitSha!: string | null;

  @Column({ name: 'embedding', type: 'text', nullable: true })
  embedding!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  /**
   * Phase 9: owning organization. NOT NULL since migration 014.
   * Artifacts inherit their repo's org_id — see ArtifactsService.upsertArtifacts
   * for the resolution logic.
   */
  @Column({ name: 'org_id', type: 'uuid' })
  orgId!: string;
}
