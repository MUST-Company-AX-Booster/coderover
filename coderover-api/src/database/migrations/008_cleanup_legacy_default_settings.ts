import { MigrationInterface, QueryRunner } from 'typeorm';

export class CleanupLegacyDefaultSettings1710540000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM system_settings
      WHERE key IN ('DEFAULT_REPO', 'DEFAULT_BRANCH')
    `);
  }

  async down(): Promise<void> {}
}
