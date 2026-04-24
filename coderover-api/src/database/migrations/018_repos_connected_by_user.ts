import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 10 (2026-04-16).
 *
 * `repos.connected_by_user_id` — FK back to the user who registered this
 * repo via OAuth. Enables `GitHubTokenResolver` to fetch a fresh access
 * token from `github_connections` at ingest/PR-review time instead of
 * relying on the stale PAT stored in `repos.github_token`.
 *
 * Nullable because:
 *   - existing rows were registered before OAuth unification;
 *   - manually-registered repos (URL + PAT "Advanced" flow) still use
 *     `repos.github_token` directly and never set this FK.
 *
 * ON DELETE SET NULL so removing a user doesn't cascade-delete their repos;
 * the resolver falls back to `repos.github_token` → env `GITHUB_TOKEN`.
 */
export class ReposConnectedByUser1713200000018 implements MigrationInterface {
  name = 'ReposConnectedByUser1713200000018';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "repos"
      ADD COLUMN IF NOT EXISTS "connected_by_user_id" uuid NULL;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'FK_repos_connected_by_user'
        ) THEN
          ALTER TABLE "repos"
          ADD CONSTRAINT "FK_repos_connected_by_user"
          FOREIGN KEY ("connected_by_user_id")
          REFERENCES "users"("id")
          ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_repos_connected_by_user"
      ON "repos" ("connected_by_user_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_repos_connected_by_user";`);
    await queryRunner.query(
      `ALTER TABLE "repos" DROP CONSTRAINT IF EXISTS "FK_repos_connected_by_user";`,
    );
    await queryRunner.query(`ALTER TABLE "repos" DROP COLUMN IF EXISTS "connected_by_user_id";`);
  }
}
