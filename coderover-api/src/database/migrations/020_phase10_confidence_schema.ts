import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 10 B1 (2026-04-17) — Distribution + Trust.
 *
 * Additive schema for confidence tagging. Creates:
 *
 *   1. `confidence_tag` Postgres enum (EXTRACTED | INFERRED | AMBIGUOUS).
 *   2. `rag_citations`       — one row per chat citation (was nested JSONB on chat_messages.source_chunks).
 *   3. `pr_review_findings`  — one row per PR finding (was nested JSONB on pr_reviews.findings.items).
 *   4. `edge_producer_audit` — records which producer wrote each graph edge + self-reported confidence.
 *                              Re-tag job reads this to promote AMBIGUOUS → EXTRACTED/INFERRED.
 *   5. `graph_migrations`    — tracker for idempotent Memgraph Cypher migrations
 *                              (Memgraph itself has no schema versioning).
 *
 * Existing JSONB columns on `chat_messages.source_chunks` and `pr_reviews.findings`
 * are kept for backward compat during the rollout. Writers switch to the new tables
 * in B2; JSONB writes are deprecated then.
 *
 * Defaults are `AMBIGUOUS` / null — existing rows pre-date the producer classification.
 * Migration 021 backfills rows from JSONB; the background `ConfidenceRetagJob` promotes
 * them based on `edge_producer_audit` entries once B2 producers populate that table.
 */
export class Phase10ConfidenceSchema1713200000020 implements MigrationInterface {
  name = 'Phase10ConfidenceSchema1713200000020';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Enum — shared across all tables.
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'confidence_tag') THEN
          CREATE TYPE "confidence_tag" AS ENUM ('EXTRACTED', 'INFERRED', 'AMBIGUOUS');
        END IF;
      END $$;
    `);

    // 2. rag_citations — chat citation rows.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "rag_citations" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "chat_message_id" uuid NOT NULL,
        "org_id" uuid NOT NULL,
        "file_path" text NOT NULL,
        "line_start" int NULL,
        "line_end" int NULL,
        "similarity" double precision NULL,
        "confidence" "confidence_tag" NOT NULL DEFAULT 'AMBIGUOUS',
        "confidence_score" double precision NULL,
        "evidence_ref" jsonb NULL,
        "producer" text NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'FK_rag_citations_chat_message'
        ) THEN
          ALTER TABLE "rag_citations"
          ADD CONSTRAINT "FK_rag_citations_chat_message"
          FOREIGN KEY ("chat_message_id")
          REFERENCES "chat_messages"("id")
          ON DELETE CASCADE;
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_rag_citations_chat_message_id" ON "rag_citations" ("chat_message_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_rag_citations_org_id" ON "rag_citations" ("org_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_rag_citations_confidence" ON "rag_citations" ("confidence");
    `);

    // 3. pr_review_findings — one row per finding.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "pr_review_findings" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "pr_review_id" uuid NOT NULL,
        "org_id" uuid NULL,
        "file" text NULL,
        "line" int NULL,
        "title" text NOT NULL,
        "body" text NOT NULL,
        "severity" text NOT NULL,
        "category" text NOT NULL,
        "confidence" "confidence_tag" NOT NULL DEFAULT 'AMBIGUOUS',
        "confidence_score" double precision NULL,
        "evidence_ref" jsonb NULL,
        "producer" text NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'FK_pr_review_findings_pr_review'
        ) THEN
          ALTER TABLE "pr_review_findings"
          ADD CONSTRAINT "FK_pr_review_findings_pr_review"
          FOREIGN KEY ("pr_review_id")
          REFERENCES "pr_reviews"("id")
          ON DELETE CASCADE;
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_pr_review_findings_pr_review_id" ON "pr_review_findings" ("pr_review_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_pr_review_findings_org_id" ON "pr_review_findings" ("org_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_pr_review_findings_confidence" ON "pr_review_findings" ("confidence");
    `);

    // 4. edge_producer_audit — input to ConfidenceRetagJob.
    //    edge_id is TEXT for forward compat with C2-bis deterministic hashes.
    //    producer_kind is the tagger's classification, not a free-form label.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "edge_producer_audit" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "edge_id" text NOT NULL,
        "relation_kind" text NOT NULL,
        "producer" text NOT NULL,
        "producer_kind" "confidence_tag" NOT NULL,
        "producer_confidence" double precision NULL,
        "org_id" uuid NULL,
        "evidence_ref" jsonb NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_edge_producer_audit_edge_id" ON "edge_producer_audit" ("edge_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_edge_producer_audit_org_id" ON "edge_producer_audit" ("org_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_edge_producer_audit_created_at" ON "edge_producer_audit" ("created_at");
    `);

    // 5. graph_migrations — Cypher-level migration tracker for Memgraph.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "graph_migrations" (
        "name" text PRIMARY KEY,
        "applied_at" timestamptz NOT NULL DEFAULT now()
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "graph_migrations";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_edge_producer_audit_created_at";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_edge_producer_audit_org_id";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_edge_producer_audit_edge_id";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "edge_producer_audit";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_pr_review_findings_confidence";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_pr_review_findings_org_id";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_pr_review_findings_pr_review_id";`);
    await queryRunner.query(
      `ALTER TABLE "pr_review_findings" DROP CONSTRAINT IF EXISTS "FK_pr_review_findings_pr_review";`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "pr_review_findings";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_rag_citations_confidence";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_rag_citations_org_id";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_rag_citations_chat_message_id";`);
    await queryRunner.query(
      `ALTER TABLE "rag_citations" DROP CONSTRAINT IF EXISTS "FK_rag_citations_chat_message";`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "rag_citations";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "confidence_tag";`);
  }
}
