import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 4B (Zero Trust) — `llm_audit_log` table.
 *
 * One row per outbound LLM call (kept fire-and-forget so logging never
 * blocks the user request). Stores the org/user that triggered it, the
 * call-site identifier, model + provider, SHA256 of the prompt and
 * response (NOT the raw text — see entity comment), token counts,
 * latency, the post-validator redaction tally, the kill-switch-blocked
 * flag, and the error message on failure.
 *
 * Indexes target the access patterns Phase 4C alerts will use:
 *   - `(org_id, created_at)` — recent traffic per org for rate /
 *     token-spike detection.
 *   - `(call_site, created_at)` — recent traffic per surface so an
 *     alert can scope to "copilot.chat last 10 min".
 *
 * Retention is intentionally not enforced at the DB layer — operators
 * can run a periodic DELETE WHERE created_at < now() - interval 'N days'
 * via cron when storage becomes a concern. The hash-only design makes
 * the rows compact (~200 bytes each) so 10M rows is roughly 2 GB.
 */
export class LLMAuditLog1714000000024 implements MigrationInterface {
  name = 'LLMAuditLog1714000000024';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "llm_audit_log" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "org_id" uuid NULL,
        "user_id" uuid NULL,
        "call_site" text NOT NULL,
        "provider" text NOT NULL,
        "model" text NOT NULL,
        "prompt_hash" text NOT NULL,
        "response_hash" text NULL,
        "prompt_chars" integer NOT NULL,
        "response_chars" integer NULL,
        "prompt_tokens" integer NULL,
        "completion_tokens" integer NULL,
        "total_tokens" integer NULL,
        "latency_ms" integer NULL,
        "kill_switch_blocked" boolean NOT NULL DEFAULT false,
        "redactions" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "error" text NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_llm_audit_org_created"
        ON "llm_audit_log" ("org_id", "created_at" DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_llm_audit_call_site_created"
        ON "llm_audit_log" ("call_site", "created_at" DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_llm_audit_call_site_created";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_llm_audit_org_created";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "llm_audit_log";`);
  }
}
