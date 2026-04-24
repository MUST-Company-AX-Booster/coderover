import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 9 / Workstream F: per-org token usage accounting + caps.
 */
export class TokenUsage1713000000012 implements MigrationInterface {
  name = 'TokenUsage1713000000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "token_usage_periods" (
        "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "period_start" date NOT NULL,
        "prompt_tokens" bigint NOT NULL DEFAULT 0,
        "completion_tokens" bigint NOT NULL DEFAULT 0,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        UNIQUE ("org_id", "period_start")
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_token_usage_period" ON "token_usage_periods"("period_start");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "installed_plugins" (
        "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "name" varchar(128) NOT NULL,
        "version" varchar(32) NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "config_json" jsonb,
        "installed_at" timestamp NOT NULL DEFAULT now(),
        UNIQUE ("org_id", "name")
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "installed_plugins";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "token_usage_periods";`);
  }
}
