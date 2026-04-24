import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 10 (2026-04-16).
 *
 * Fix the `github_connections` table for the unified OAuth rewrite:
 *
 * 1. `user_id` was historically written as `text` because the old
 *    `auth.service.loginWithGitHubCode` keyed connections by the user's
 *    primary email instead of their UUID. The new flow writes the real
 *    `users.id`. We delete any rows whose user_id is not a valid users.id
 *    (those are unreachable anyway — OAuth is re-runnable) and convert the
 *    column to `uuid` with a FK + ON DELETE CASCADE.
 * 2. Add `refresh_token`, `access_token_expires_at`, `refresh_token_expires_at`
 *    columns so we can keep GitHub App + classic OAuth tokens fresh without
 *    forcing the user to re-authenticate.
 *
 * Idempotent and safe to re-run; wrapped DO blocks check current state.
 */
export class GithubConnectionRefreshToken1713200000017 implements MigrationInterface {
  name = 'GithubConnectionRefreshToken1713200000017';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add the new nullable columns first so in-flight reads keep working.
    await queryRunner.query(`
      ALTER TABLE "github_connections"
      ADD COLUMN IF NOT EXISTS "refresh_token" text NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE "github_connections"
      ADD COLUMN IF NOT EXISTS "access_token_expires_at" timestamptz NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE "github_connections"
      ADD COLUMN IF NOT EXISTS "refresh_token_expires_at" timestamptz NULL;
    `);

    // Migrate user_id: text(email) → uuid(users.id).
    // Only runs if user_id is still `text`.
    await queryRunner.query(`
      DO $$
      DECLARE
        current_type text;
      BEGIN
        SELECT data_type INTO current_type
        FROM information_schema.columns
        WHERE table_name = 'github_connections' AND column_name = 'user_id';

        IF current_type = 'text' THEN
          -- Drop old rows that don't map to a real user.
          DELETE FROM github_connections gc
          WHERE NOT EXISTS (
            SELECT 1 FROM users u WHERE u.id::text = gc.user_id
          );

          -- Drop unique constraint/index on text column if present.
          IF EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE tablename = 'github_connections' AND indexname = 'UQ_github_connections_user_id'
          ) THEN
            DROP INDEX "UQ_github_connections_user_id";
          END IF;

          -- Convert column type.
          ALTER TABLE "github_connections"
            ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;

          -- Add FK + unique constraint.
          ALTER TABLE "github_connections"
            ADD CONSTRAINT "FK_github_connections_user"
            FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
          CREATE UNIQUE INDEX IF NOT EXISTS "UQ_github_connections_user_id"
            ON "github_connections"("user_id");
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "github_connections"
      DROP CONSTRAINT IF EXISTS "FK_github_connections_user";
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_github_connections_user_id";`);
    // Narrow rollback: keep the type as uuid. Reverting to text would require
    // a text cast that loses FK validity anyway.
    await queryRunner.query(`
      ALTER TABLE "github_connections"
      DROP COLUMN IF EXISTS "refresh_token_expires_at",
      DROP COLUMN IF EXISTS "access_token_expires_at",
      DROP COLUMN IF EXISTS "refresh_token";
    `);
  }
}
