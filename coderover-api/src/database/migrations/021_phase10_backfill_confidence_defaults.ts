import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 10 B1 (2026-04-17) — Backfill confidence rows from legacy JSONB.
 *
 * Walks every existing `chat_messages.source_chunks` array and `pr_reviews.findings.items`
 * array, inserting one row per element into `rag_citations` / `pr_review_findings` with
 * `confidence = AMBIGUOUS` (default) and `confidence_score = NULL`.
 *
 * The background `ConfidenceRetagJob` promotes these rows later, based on audit entries
 * populated by B2 producers. Until B2 lands, every backfilled row stays AMBIGUOUS — that
 * is intentional and matches critical-gap test #6.
 *
 * JSONB source columns are left in place for backward compat during rollout.
 *
 * Idempotent: the queries guard against re-insertion by checking for existing rows
 * per (parent_id, source position). Re-running this migration is a no-op.
 */
export class Phase10BackfillConfidenceDefaults1713200000021 implements MigrationInterface {
  name = 'Phase10BackfillConfidenceDefaults1713200000021';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Backfill rag_citations from chat_messages.source_chunks.
    //
    // source_chunks shape (per copilot.service.ts:165):
    //   Array<{ filePath: string, lines: "N-M" | "N", similarity: number }>
    //
    // Parse `lines` string defensively: "10-20" → line_start=10, line_end=20;
    //                                   "42"    → line_start=line_end=42;
    //                                   other   → both NULL.
    //
    // Skip messages that already have any citations (idempotency guard).
    await queryRunner.query(`
      INSERT INTO "rag_citations"
        ("chat_message_id", "org_id", "file_path", "line_start", "line_end", "similarity", "confidence")
      SELECT
        cm.id,
        cm.org_id,
        (elem->>'filePath'),
        CASE
          WHEN (elem->>'lines') ~ '^\\d+-\\d+$' THEN split_part(elem->>'lines', '-', 1)::int
          WHEN (elem->>'lines') ~ '^\\d+$'     THEN (elem->>'lines')::int
          ELSE NULL
        END,
        CASE
          WHEN (elem->>'lines') ~ '^\\d+-\\d+$' THEN split_part(elem->>'lines', '-', 2)::int
          WHEN (elem->>'lines') ~ '^\\d+$'     THEN (elem->>'lines')::int
          ELSE NULL
        END,
        CASE
          WHEN (elem->>'similarity') ~ '^-?\\d+(\\.\\d+)?$' THEN (elem->>'similarity')::double precision
          ELSE NULL
        END,
        'AMBIGUOUS'::confidence_tag
      FROM "chat_messages" cm,
           jsonb_array_elements(cm.source_chunks) AS elem
      WHERE cm.source_chunks IS NOT NULL
        AND jsonb_typeof(cm.source_chunks) = 'array'
        AND jsonb_array_length(cm.source_chunks) > 0
        AND (elem->>'filePath') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "rag_citations" rc WHERE rc."chat_message_id" = cm.id
        );
    `);

    // 2. Backfill pr_review_findings from pr_reviews.findings.items.
    //
    // findings shape (per pr-review.service.ts:252):
    //   { score: number, recommendation: string, items: Array<ReviewFinding> }
    //
    // ReviewFinding (pr-review.service.ts:40):
    //   { file?: string, line?: number, title: string, body: string,
    //     severity: 'low'|'medium'|'high'|'critical',
    //     category: 'security'|'performance'|'correctness'|'style'|'maintainability' }
    //
    // Handles: missing items array, missing title/body (defaults), non-integer line.
    await queryRunner.query(`
      INSERT INTO "pr_review_findings"
        ("pr_review_id", "org_id", "file", "line", "title", "body", "severity", "category", "confidence")
      SELECT
        pr.id,
        pr.org_id,
        (item->>'file'),
        CASE
          WHEN (item->>'line') ~ '^\\d+$' THEN (item->>'line')::int
          ELSE NULL
        END,
        COALESCE(item->>'title', '(untitled)'),
        COALESCE(item->>'body', ''),
        COALESCE(item->>'severity', 'low'),
        COALESCE(item->>'category', 'maintainability'),
        'AMBIGUOUS'::confidence_tag
      FROM "pr_reviews" pr,
           jsonb_array_elements(pr.findings->'items') AS item
      WHERE pr.findings IS NOT NULL
        AND jsonb_typeof(pr.findings) = 'object'
        AND pr.findings ? 'items'
        AND jsonb_typeof(pr.findings->'items') = 'array'
        AND NOT EXISTS (
          SELECT 1 FROM "pr_review_findings" prf WHERE prf."pr_review_id" = pr.id
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Only delete backfilled rows (those still flagged AMBIGUOUS with no producer recorded).
    // Preserves any rows written after B2 producers came online.
    await queryRunner.query(`
      DELETE FROM "rag_citations"
      WHERE "confidence" = 'AMBIGUOUS' AND "producer" IS NULL;
    `);
    await queryRunner.query(`
      DELETE FROM "pr_review_findings"
      WHERE "confidence" = 'AMBIGUOUS' AND "producer" IS NULL;
    `);
  }
}
