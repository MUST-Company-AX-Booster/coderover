import { MigrationInterface, QueryRunner } from 'typeorm';

export class StructuralMetadata1700000000003 implements MigrationInterface {
  name = 'StructuralMetadata1700000000003';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Add structural columns to code_chunks
    await queryRunner.query(`ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS symbols JSONB`);
    await queryRunner.query(`ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS imports JSONB`);
    await queryRunner.query(`ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS nest_role TEXT`);
    await queryRunner.query(`ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS exports JSONB`);

    // Index for symbol-name search: GIN on symbols
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_code_chunks_symbols ON code_chunks USING GIN (symbols)`);
    // Index for nest_role filter
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_code_chunks_nest_role ON code_chunks (nest_role) WHERE nest_role IS NOT NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_code_chunks_symbols`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_code_chunks_nest_role`);
    await queryRunner.query(`ALTER TABLE code_chunks DROP COLUMN IF EXISTS symbols`);
    await queryRunner.query(`ALTER TABLE code_chunks DROP COLUMN IF EXISTS imports`);
    await queryRunner.query(`ALTER TABLE code_chunks DROP COLUMN IF EXISTS nest_role`);
    await queryRunner.query(`ALTER TABLE code_chunks DROP COLUMN IF EXISTS exports`);
  }
}
