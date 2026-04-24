import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 10 (2026-04-16).
 *
 * Seed empty rows in `system_settings` for every key newly promoted to
 * "managed" status by AdminConfigService in this release. Rows with
 * `value = null` are harmless — `AdminConfigService.getSettingString` falls
 * back to `ConfigService.get(key)` (env) when the DB row is null, so the
 * app keeps working exactly as before. Admins can then fill the rows in
 * from the Settings UI to override env at runtime.
 *
 * Secret rows are flagged `is_secret = true` so future encryption (applied
 * at app startup) and UI redaction work correctly.
 *
 * Idempotent: `ON CONFLICT (key) DO NOTHING`.
 */
export class SeedManagedKeys1713200000019 implements MigrationInterface {
  name = 'SeedManagedKeys1713200000019';

  private readonly NEW_MANAGED_KEYS: Array<{ key: string; isSecret: boolean }> = [
    // GitHub
    { key: 'GITHUB_CLIENT_ID', isSecret: false },
    { key: 'GITHUB_CLIENT_SECRET', isSecret: true },
    { key: 'GITHUB_CALLBACK_URL', isSecret: false },
    { key: 'GITHUB_APP_ID', isSecret: false },
    { key: 'GITHUB_APP_PRIVATE_KEY', isSecret: true },
    // App
    { key: 'FRONTEND_APP_URL', isSecret: false },
    { key: 'PUBLIC_API_BASE_URL', isSecret: false },
    // Feature flags + cadence
    { key: 'LLM_HEALTH_CHECK_ENABLED', isSecret: false },
    { key: 'AGENT_PR_ENABLED', isSecret: false },
    { key: 'AGENT_SCAN_ON_PUSH', isSecret: false },
    { key: 'AGENT_HEALTH_CRON', isSecret: false },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const { key, isSecret } of this.NEW_MANAGED_KEYS) {
      await queryRunner.query(
        `
        INSERT INTO "system_settings" ("key", "value", "is_secret", "version", "updated_by")
        VALUES ($1, NULL, $2, 1, 'system-bootstrap')
        ON CONFLICT ("key") DO NOTHING;
        `,
        [key, isSecret],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const keys = this.NEW_MANAGED_KEYS.map((k) => k.key);
    await queryRunner.query(
      `DELETE FROM "system_settings" WHERE "key" = ANY($1::text[]) AND "updated_by" = 'system-bootstrap';`,
      [keys],
    );
  }
}
