import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 5 — Multi-Language & Hybrid Search
 * Adds:
 *   - language column on code_chunks  (detected language: typescript, python, go, java, etc.)
 *   - framework column on code_chunks (detected framework: nestjs, nextjs, vite-vue, etc.)
 *   - artifact_type column            (source | schema | openapi | terraform | markdown)
 *   - chunk_tsv tsvector column       (pre-computed BM25 index for hybrid search)
 *   - repos.framework column          (repo-level framework detection result)
 *   - context_artifacts table         (DB schemas, OpenAPI specs, Terraform, architecture docs)
 */
export class HybridSearch1710510000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // ── code_chunks extensions ────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE code_chunks
        ADD COLUMN IF NOT EXISTS language      TEXT,
        ADD COLUMN IF NOT EXISTS framework     TEXT,
        ADD COLUMN IF NOT EXISTS artifact_type TEXT NOT NULL DEFAULT 'source',
        ADD COLUMN IF NOT EXISTS chunk_tsv     TSVECTOR
    `);

    // GIN index for BM25 full-text search
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_code_chunks_tsv
        ON code_chunks USING GIN (chunk_tsv)
    `);

    // Index for language/framework filters
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_code_chunks_language
        ON code_chunks (language)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_code_chunks_framework
        ON code_chunks (framework)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_code_chunks_artifact_type
        ON code_chunks (artifact_type)
    `);

    // Trigger to keep chunk_tsv updated on INSERT/UPDATE
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION code_chunks_tsv_update() RETURNS trigger AS $$
      BEGIN
        NEW.chunk_tsv := to_tsvector(
          'english',
          regexp_replace(
            coalesce(NEW.chunk_text, ''),
            '([a-z0-9])([A-Z])',
            '\\1 \\2',
            'g'
          )
        );
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS code_chunks_tsv_trigger ON code_chunks
    `);

    await queryRunner.query(`
      CREATE TRIGGER code_chunks_tsv_trigger
        BEFORE INSERT OR UPDATE OF chunk_text
        ON code_chunks
        FOR EACH ROW EXECUTE FUNCTION code_chunks_tsv_update()
    `);

    // Backfill existing rows
    await queryRunner.query(`
      UPDATE code_chunks
      SET chunk_tsv = to_tsvector(
        'english',
        regexp_replace(coalesce(chunk_text, ''), '([a-z0-9])([A-Z])', '\\1 \\2', 'g')
      )
      WHERE chunk_tsv IS NULL
    `);

    // ── repos extensions ──────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE repos
        ADD COLUMN IF NOT EXISTS framework TEXT,
        ADD COLUMN IF NOT EXISTS languages JSONB
    `);

    // ── context_artifacts table ───────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS context_artifacts (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        repo_id       UUID REFERENCES repos(id) ON DELETE CASCADE,
        artifact_type TEXT NOT NULL,
        file_path     TEXT NOT NULL,
        content       TEXT NOT NULL,
        metadata      JSONB,
        commit_sha    TEXT,
        embedding     TEXT,
        chunk_tsv     TSVECTOR,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (repo_id, file_path)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_context_artifacts_repo
        ON context_artifacts (repo_id)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_context_artifacts_type
        ON context_artifacts (artifact_type)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_context_artifacts_tsv
        ON context_artifacts USING GIN (chunk_tsv)
    `);

    // Trigger for context_artifacts tsv
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION context_artifacts_tsv_update() RETURNS trigger AS $$
      BEGIN
        NEW.chunk_tsv := to_tsvector('english', coalesce(NEW.content, ''));
        NEW.updated_at := now();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS context_artifacts_tsv_trigger ON context_artifacts
    `);

    await queryRunner.query(`
      CREATE TRIGGER context_artifacts_tsv_trigger
        BEFORE INSERT OR UPDATE OF content
        ON context_artifacts
        FOR EACH ROW EXECUTE FUNCTION context_artifacts_tsv_update()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS context_artifacts`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS code_chunks_tsv_trigger ON code_chunks`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS code_chunks_tsv_update`);
    await queryRunner.query(`
      ALTER TABLE code_chunks
        DROP COLUMN IF EXISTS language,
        DROP COLUMN IF EXISTS framework,
        DROP COLUMN IF EXISTS artifact_type,
        DROP COLUMN IF EXISTS chunk_tsv
    `);
    await queryRunner.query(`
      ALTER TABLE repos
        DROP COLUMN IF EXISTS framework,
        DROP COLUMN IF EXISTS languages
    `);
  }
}
