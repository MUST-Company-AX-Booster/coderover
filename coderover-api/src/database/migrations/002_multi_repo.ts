import { MigrationInterface, QueryRunner } from 'typeorm';

export class MultiRepo1700000000002 implements MigrationInterface {
  name = 'MultiRepo1700000000002';

  async up(queryRunner: QueryRunner): Promise<void> {
    // repos table
    await queryRunner.query(`
      CREATE TABLE repos (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        full_name TEXT NOT NULL UNIQUE,
        github_token TEXT,
        branch TEXT NOT NULL DEFAULT 'main',
        label TEXT,
        language TEXT,
        file_count INT DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Add repo_id to code_chunks
    await queryRunner.query(`ALTER TABLE code_chunks ADD COLUMN repo_id UUID REFERENCES repos(id) ON DELETE CASCADE`);
    await queryRunner.query(`CREATE INDEX idx_code_chunks_repo_id ON code_chunks (repo_id)`);
    await queryRunner.query(`ALTER TABLE code_chunks DROP CONSTRAINT IF EXISTS uq_chunk`);
    await queryRunner.query(`ALTER TABLE code_chunks ADD CONSTRAINT uq_chunk UNIQUE (repo_id, file_path, line_start, line_end)`);

    // Add repo_id to sync_log
    await queryRunner.query(`ALTER TABLE sync_log ADD COLUMN repo_id UUID REFERENCES repos(id) ON DELETE SET NULL`);

    // Add repo_ids to chat_sessions
    await queryRunner.query(`ALTER TABLE chat_sessions ADD COLUMN repo_ids UUID[]`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE chat_sessions DROP COLUMN IF EXISTS repo_ids`);
    await queryRunner.query(`ALTER TABLE sync_log DROP COLUMN IF EXISTS repo_id`);
    await queryRunner.query(`ALTER TABLE code_chunks DROP CONSTRAINT IF EXISTS uq_chunk`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_code_chunks_repo_id`);
    await queryRunner.query(`ALTER TABLE code_chunks ADD CONSTRAINT uq_chunk UNIQUE (file_path, line_start, line_end)`);
    await queryRunner.query(`ALTER TABLE code_chunks DROP COLUMN IF EXISTS repo_id`);
    await queryRunner.query(`DROP TABLE IF EXISTS repos`);
  }
}
