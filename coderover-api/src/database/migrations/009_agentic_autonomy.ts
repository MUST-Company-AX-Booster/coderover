import { MigrationInterface, QueryRunner } from 'typeorm';

export class AgenticAutonomy1742428800000 implements MigrationInterface {
  name = 'AgenticAutonomy1742428800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add agent_config column to repos
    await queryRunner.query(
      `ALTER TABLE "repos" ADD "agent_config" jsonb NOT NULL DEFAULT '{}'`
    );

    // Add processed_by_agent column to webhook_events
    await queryRunner.query(
      `ALTER TABLE "webhook_events" ADD "processed_by_agent" boolean NOT NULL DEFAULT false`
    );

    // Create agent_runs table
    await queryRunner.query(`
      CREATE TABLE "agent_runs" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "repo_id" uuid NOT NULL,
        "agent_type" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'queued',
        "trigger" character varying NOT NULL,
        "started_at" TIMESTAMP,
        "completed_at" TIMESTAMP,
        "llm_tokens_used" integer NOT NULL DEFAULT 0,
        "findings_count" integer NOT NULL DEFAULT 0,
        "error_message" text,
        "metadata" jsonb NOT NULL DEFAULT '{}',
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "FK_agent_runs_repo_id" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE
      )
    `);

    // Create agent_memory table
    await queryRunner.query(`
      CREATE TABLE "agent_memory" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "repo_id" uuid NOT NULL,
        "memory_type" character varying NOT NULL,
        "key" character varying NOT NULL,
        "value" jsonb NOT NULL,
        "expires_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "FK_agent_memory_repo_id" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE
      )
    `);

    // Create agent_rules table
    await queryRunner.query(`
      CREATE TABLE "agent_rules" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "repo_id" uuid,
        "name" character varying NOT NULL,
        "description" text NOT NULL,
        "detection_pattern" jsonb NOT NULL,
        "severity" character varying NOT NULL DEFAULT 'warning',
        "auto_fix_template" text,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "FK_agent_rules_repo_id" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE
      )
    `);

    // Create agent_approvals table
    await queryRunner.query(`
      CREATE TABLE "agent_approvals" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "agent_run_id" uuid NOT NULL,
        "action_type" character varying NOT NULL,
        "action_payload" jsonb NOT NULL,
        "status" character varying NOT NULL DEFAULT 'pending',
        "approval_token" character varying NOT NULL,
        "approver" character varying,
        "decided_at" TIMESTAMP,
        "expires_at" TIMESTAMP NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_agent_approvals_token" UNIQUE ("approval_token"),
        CONSTRAINT "FK_agent_approvals_agent_run_id" FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "agent_approvals"`);
    await queryRunner.query(`DROP TABLE "agent_rules"`);
    await queryRunner.query(`DROP TABLE "agent_memory"`);
    await queryRunner.query(`DROP TABLE "agent_runs"`);
    await queryRunner.query(`ALTER TABLE "webhook_events" DROP COLUMN "processed_by_agent"`);
    await queryRunner.query(`ALTER TABLE "repos" DROP COLUMN "agent_config"`);
  }
}
