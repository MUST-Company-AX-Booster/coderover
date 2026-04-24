import { MigrationInterface, QueryRunner } from 'typeorm';

export class EntityGraph1710600000000 implements MigrationInterface {
  name = 'EntityGraph1710600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Store method-level data separately from chunk symbols
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS code_methods (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        repo_id UUID REFERENCES repos(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        class_name TEXT NOT NULL,
        method_name TEXT NOT NULL,
        start_line INT,
        end_line INT,
        parameters JSONB DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Store call relationships
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS code_calls (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        repo_id UUID REFERENCES repos(id) ON DELETE CASCADE,
        caller_file TEXT NOT NULL,
        caller_name TEXT NOT NULL,
        caller_kind TEXT NOT NULL,
        callee_name TEXT NOT NULL,
        callee_qualified TEXT,
        call_line INT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Store inheritance relationships
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS code_inheritance (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        repo_id UUID REFERENCES repos(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        class_name TEXT NOT NULL,
        extends_class TEXT,
        implements_interfaces JSONB DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Indexes for fast lookup
    await queryRunner.query(`CREATE INDEX idx_code_methods_repo ON code_methods(repo_id)`);
    await queryRunner.query(`CREATE INDEX idx_code_methods_lookup ON code_methods(repo_id, file_path, class_name)`);
    await queryRunner.query(`CREATE INDEX idx_code_calls_repo ON code_calls(repo_id)`);
    await queryRunner.query(`CREATE INDEX idx_code_calls_callee ON code_calls(repo_id, callee_name)`);
    await queryRunner.query(`CREATE INDEX idx_code_inheritance_repo ON code_inheritance(repo_id)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_code_inheritance_repo`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_code_calls_callee`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_code_calls_repo`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_code_methods_lookup`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_code_methods_repo`);
    
    await queryRunner.query(`DROP TABLE IF EXISTS code_inheritance`);
    await queryRunner.query(`DROP TABLE IF EXISTS code_calls`);
    await queryRunner.query(`DROP TABLE IF EXISTS code_methods`);
  }
}
