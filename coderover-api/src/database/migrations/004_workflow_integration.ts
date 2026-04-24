import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 4 — Workflow Integration
 * Adds:
 *   - webhook_events  : log every inbound GitHub webhook (push / PR)
 *   - Extends pr_reviews with: github_comment_id, review_url, ai_model
 */
export class WorkflowIntegration1710420000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // ── webhook_events ────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS webhook_events (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type   TEXT NOT NULL,
        action       TEXT,
        repo         TEXT NOT NULL,
        ref          TEXT,
        commit_sha   TEXT,
        pr_number    INT,
        sender       TEXT,
        payload      JSONB,
        processed    BOOLEAN NOT NULL DEFAULT FALSE,
        error        TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_webhook_events_repo
        ON webhook_events (repo)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_webhook_events_event_type
        ON webhook_events (event_type, processed)
    `);

    // ── Extend pr_reviews ─────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE pr_reviews
        ADD COLUMN IF NOT EXISTS github_comment_id BIGINT,
        ADD COLUMN IF NOT EXISTS review_url        TEXT,
        ADD COLUMN IF NOT EXISTS ai_model          TEXT,
        ADD COLUMN IF NOT EXISTS repo_id           UUID REFERENCES repos(id) ON DELETE SET NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS webhook_events`);
    await queryRunner.query(`
      ALTER TABLE pr_reviews
        DROP COLUMN IF EXISTS github_comment_id,
        DROP COLUMN IF EXISTS review_url,
        DROP COLUMN IF EXISTS ai_model,
        DROP COLUMN IF EXISTS repo_id
    `);
  }
}
