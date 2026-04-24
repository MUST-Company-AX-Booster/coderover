import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
} from 'typeorm';

/**
 * Phase 10 C1 — Content-addressed cache metadata.
 *
 * One row per (cache_key, artifact_kind). `cache_key` is the SHA256 of the
 * normalized file contents (LF line endings, BOM stripped). Blobs live in
 * a backend-agnostic blob store (local FS or S3-compat) under:
 *
 *   cache/{artifact_kind}/{key[0:2]}/{key[2:4]}/{key}.bin
 *
 * `last_accessed_at` is bumped on every `get` hit and drives the LRU
 * eviction sweep. `size_bytes` lets the eviction service compute total
 * cache footprint without stat-ing each blob.
 */
@Entity('cache_entries')
@Unique('uq_cache_entries_key_kind', ['cacheKey', 'artifactKind'])
export class CacheEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'cache_key', type: 'text' })
  cacheKey!: string;

  @Column({ name: 'artifact_kind', type: 'text' })
  artifactKind!: string;

  @Column({ name: 'blob_path', type: 'text' })
  blobPath!: string;

  @Column({ name: 'size_bytes', type: 'bigint', default: 0 })
  sizeBytes!: string | number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Index('idx_cache_entries_last_accessed_at')
  @Column({ name: 'last_accessed_at', type: 'timestamptz', default: () => 'now()' })
  lastAccessedAt!: Date;

  @Index('idx_cache_entries_org_id')
  @Column({ name: 'org_id', type: 'uuid', nullable: true })
  orgId!: string | null;
}
