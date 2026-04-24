import { MigrationInterface, QueryRunner } from 'typeorm';

export class AdminGithubProd1710520000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value JSONB,
        is_secret BOOLEAN NOT NULL DEFAULT false,
        version INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS setting_audits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        setting_key TEXT NOT NULL REFERENCES system_settings(key) ON DELETE CASCADE,
        previous_value JSONB,
        next_value JSONB,
        version INTEGER NOT NULL,
        reason TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_setting_audits_key_created
        ON setting_audits (setting_key, created_at DESC)
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS github_connections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id TEXT NOT NULL UNIQUE,
        access_token TEXT NOT NULL,
        token_type TEXT NOT NULL DEFAULT 'bearer',
        scope TEXT,
        github_login TEXT,
        github_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS github_connections`);
    await queryRunner.query(`DROP TABLE IF EXISTS setting_audits`);
    await queryRunner.query(`DROP TABLE IF EXISTS system_settings`);
  }
}
