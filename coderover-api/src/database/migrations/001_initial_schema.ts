import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1700000000001 implements MigrationInterface {
  name = 'InitialSchema1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enable pgvector extension
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    // code_chunks with vector column and HNSW index
    await queryRunner.query(`
      CREATE TABLE code_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        file_path TEXT NOT NULL,
        module_name TEXT,
        chunk_text TEXT NOT NULL,
        embedding VECTOR(1536),
        commit_sha TEXT,
        line_start INT,
        line_end INT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_chunk UNIQUE (file_path, line_start, line_end)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX idx_code_chunks_embedding ON code_chunks USING hnsw (embedding vector_cosine_ops)`,
    );

    // sync_log
    await queryRunner.query(`
      CREATE TABLE sync_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        repo TEXT NOT NULL,
        last_commit_sha TEXT,
        files_indexed INT DEFAULT 0,
        chunks_total INT DEFAULT 0,
        synced_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // chat_sessions
    await queryRunner.query(`
      CREATE TABLE chat_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id TEXT NOT NULL,
        title TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // chat_messages
    await queryRunner.query(`
      CREATE TABLE chat_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls JSONB,
        source_chunks JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // pr_reviews
    await queryRunner.query(`
      CREATE TABLE pr_reviews (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pr_number INT NOT NULL,
        repo TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        diff_summary TEXT,
        findings JSONB,
        posted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS pr_reviews`);
    await queryRunner.query(`DROP TABLE IF EXISTS chat_messages`);
    await queryRunner.query(`DROP TABLE IF EXISTS chat_sessions`);
    await queryRunner.query(`DROP TABLE IF EXISTS sync_log`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_code_chunks_embedding`);
    await queryRunner.query(`DROP TABLE IF EXISTS code_chunks`);
    await queryRunner.query(`DROP EXTENSION IF EXISTS vector`);
  }
}
