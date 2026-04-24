import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 10 (2026-04-16).
 *
 * Prepare `system_settings` for encrypted-at-rest secrets. Adds a boolean
 * `encrypted` column so callers can quickly tell whether `value` is a raw
 * primitive or an `EncryptedEnvelope` JSONB without parsing it. A partial
 * index on `encrypted = true` makes bulk re-encryption queries cheap.
 *
 * The actual plaintext→ciphertext rewrite is performed at app startup by
 * `AdminConfigService.onModuleInit.migrateLegacyPlaintextSecrets()` because
 * TypeORM CLI migrations don't have reliable access to
 * `SETTINGS_ENCRYPTION_KEY` in all environments. Envelope detection makes
 * the startup rewrite idempotent.
 */
export class SettingsEncryption1713200000016 implements MigrationInterface {
  name = 'SettingsEncryption1713200000016';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "system_settings"
      ADD COLUMN IF NOT EXISTS "encrypted" boolean NOT NULL DEFAULT false;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_system_settings_encrypted"
      ON "system_settings" ("encrypted") WHERE "encrypted" = true;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_system_settings_encrypted";`);
    await queryRunner.query(`ALTER TABLE "system_settings" DROP COLUMN IF EXISTS "encrypted";`);
  }
}
