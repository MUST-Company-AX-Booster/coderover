import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 10 C1 (2026-04-17) — Content-addressed file cache metadata.
 *
 * Creates `cache_entries` table. Every artifact the `ContentCache` persists
 * (AST, embeddings, extracted symbols, graph deltas) stores metadata here so
 * the eviction service can run LRU sweeps + 90-day TTL cleanup without
 * scanning the blob store.
 *
 *   - `cache_key`     : SHA256 of normalized file content (see ContentCacheService.computeKey)
 *   - `artifact_kind` : 'ast' | 'embeddings' | 'symbols' | 'graph_delta'
 *   - `blob_path`     : sharded path into the blob store
 *                       (cache/{kind}/{key[0:2]}/{key[2:4]}/{key}.bin)
 *   - `last_accessed_at` : touched on every successful `get`; drives LRU eviction
 *
 * The `(cache_key, artifact_kind)` unique index enforces a single blob per
 * (key, kind) — `put` becomes an UPSERT. The `last_accessed_at` index keeps
 * eviction sweeps fast even at 10M+ rows.
 *
 * C2 (incremental ingestion) and C3 (watch daemon) plug into the same table
 * through `ContentCacheService`; they never touch this schema directly.
 */
export class Phase10CacheMetadata1713200000023 implements MigrationInterface {
  name = 'Phase10CacheMetadata1713200000023';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "cache_entries" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "cache_key" text NOT NULL,
        "artifact_kind" text NOT NULL,
        "blob_path" text NOT NULL,
        "size_bytes" bigint NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "last_accessed_at" timestamptz NOT NULL DEFAULT now(),
        "org_id" uuid NULL
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_cache_entries_key_kind"
        ON "cache_entries" ("cache_key", "artifact_kind");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_cache_entries_last_accessed_at"
        ON "cache_entries" ("last_accessed_at");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_cache_entries_org_id"
        ON "cache_entries" ("org_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_cache_entries_org_id";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_cache_entries_last_accessed_at";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_cache_entries_key_kind";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "cache_entries";`);
  }
}
