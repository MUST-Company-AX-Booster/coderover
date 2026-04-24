import { MigrationInterface, QueryRunner } from 'typeorm';

export class AiRequestTelemetry1710530000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ai_request_metrics (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed',
        repo_id UUID REFERENCES repos(id) ON DELETE SET NULL,
        repo_full_name TEXT,
        session_id UUID REFERENCES chat_sessions(id) ON DELETE SET NULL,
        pr_review_id UUID REFERENCES pr_reviews(id) ON DELETE SET NULL,
        provider TEXT,
        model TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        first_token_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        latency_ms INT,
        duration_ms INT,
        prompt_tokens INT,
        completion_tokens INT,
        total_tokens INT,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_metrics_created_at
        ON ai_request_metrics (created_at DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_metrics_repo_created
        ON ai_request_metrics (repo_id, created_at DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_metrics_source_created
        ON ai_request_metrics (source, created_at DESC)
    `);

    await queryRunner.query(`
      ALTER TABLE pr_reviews
        ADD COLUMN IF NOT EXISTS llm_latency_ms INT,
        ADD COLUMN IF NOT EXISTS llm_duration_ms INT,
        ADD COLUMN IF NOT EXISTS prompt_tokens INT,
        ADD COLUMN IF NOT EXISTS completion_tokens INT,
        ADD COLUMN IF NOT EXISTS total_tokens INT
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE pr_reviews
        DROP COLUMN IF EXISTS llm_latency_ms,
        DROP COLUMN IF EXISTS llm_duration_ms,
        DROP COLUMN IF EXISTS prompt_tokens,
        DROP COLUMN IF EXISTS completion_tokens,
        DROP COLUMN IF EXISTS total_tokens
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS ai_request_metrics`);
  }
}
