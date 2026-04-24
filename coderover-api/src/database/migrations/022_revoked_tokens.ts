import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 10 A4 (2026-04-17) — Distribution + Trust.
 *
 * `revoked_tokens` — source of truth for MCP and user token issuance and
 * revocation. One row per JWT we care about (tokens minted via
 * `POST /auth/tokens`). The row's `id` is the JWT's `jti` claim, so the
 * revocation check on each request is a single PK lookup.
 *
 * `revoked_at IS NULL` means the token is active. Non-null means revoked.
 * We keep revoked rows around (don't hard-delete) so a user can see what
 * they revoked in the admin UI and so audit logs stay useful.
 *
 * Legacy tokens (pre-A4, no `jti`) bypass this table — the guard treats a
 * missing `jti` as "always valid so long as the JWT signature + exp hold"
 * for backward compat during the rollout.
 */
export class Phase10RevokedTokens1713200000022 implements MigrationInterface {
  name = 'Phase10RevokedTokens1713200000022';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "revoked_tokens" (
        "id" uuid PRIMARY KEY,
        "org_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "kind" text NOT NULL,
        "scope" jsonb NULL,
        "label" text NULL,
        "expires_at" timestamptz NOT NULL,
        "revoked_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
    `);

    // Hot path: list active tokens for an org (WHERE org_id = $1 AND revoked_at IS NULL).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_revoked_tokens_org_revoked"
        ON "revoked_tokens" ("org_id", "revoked_at");
    `);

    // Useful for user-scoped listings ("my tokens") without a second query.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_revoked_tokens_user_id"
        ON "revoked_tokens" ("user_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_revoked_tokens_user_id";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_revoked_tokens_org_revoked";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "revoked_tokens";`);
  }
}
