import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 9 forward-fix. Patched 2026-04-23 for fresh-install safety:
 * every statement is now guarded with IF EXISTS because migration 009
 * has a later timestamp than this one (agentic_autonomy runs AFTER this
 * one on TypeORM's timestamp-ordered queue). On a fresh deploy, agent_*
 * tables don't exist yet when this runs. The original file assumed those
 * tables existed (true in prod where 009 was applied long before this
 * hotfix was authored).
 */
export class BackfillMissingOrgIds1713100000015 implements MigrationInterface {
  name = 'BackfillMissingOrgIds1713100000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tables = [
      'chat_messages',
      'code_chunks',
      'sync_log',
      'agent_runs',
      'agent_rules',
      'agent_memory',
    ];

    // 1. Add nullable column (table-guarded)
    for (const t of tables) {
      await queryRunner.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '${t}') THEN
            EXECUTE 'ALTER TABLE "${t}" ADD COLUMN IF NOT EXISTS "org_id" uuid';
          END IF;
        END $$;
      `);
    }

    // 2. Backfill from tenancy parent (guarded)
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'chat_messages')
           AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'chat_sessions') THEN
          UPDATE chat_messages m
             SET org_id = s.org_id
            FROM chat_sessions s
           WHERE m.session_id = s.id AND m.org_id IS NULL;
        END IF;
      END $$;
    `);
    for (const t of ['code_chunks', 'sync_log', 'agent_runs', 'agent_rules', 'agent_memory']) {
      await queryRunner.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '${t}') THEN
            UPDATE "${t}" x
               SET org_id = r.org_id
              FROM repos r
             WHERE x.repo_id = r.id AND x.org_id IS NULL;
          END IF;
        END $$;
      `);
    }

    // 3. Stragglers → default org
    for (const t of tables) {
      await queryRunner.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '${t}') THEN
            UPDATE "${t}"
               SET org_id = (SELECT id FROM organizations WHERE slug = 'default')
             WHERE org_id IS NULL;
          END IF;
        END $$;
      `);
    }

    // 4. Index + FK + NOT NULL (guarded)
    for (const t of tables) {
      await queryRunner.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '${t}') THEN
            EXECUTE 'CREATE INDEX IF NOT EXISTS "idx_${t}_org_id" ON "${t}"(org_id)';
            IF NOT EXISTS (
              SELECT 1 FROM information_schema.table_constraints
              WHERE constraint_name = 'FK_${t}_org_id'
            ) THEN
              EXECUTE 'ALTER TABLE "${t}" ADD CONSTRAINT "FK_${t}_org_id" FOREIGN KEY (org_id) REFERENCES organizations(id)';
            END IF;
            EXECUTE 'ALTER TABLE "${t}" ALTER COLUMN org_id SET NOT NULL';
          END IF;
        END $$;
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const tables = [
      'chat_messages',
      'code_chunks',
      'sync_log',
      'agent_runs',
      'agent_rules',
      'agent_memory',
    ];
    for (const t of tables) {
      await queryRunner.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '${t}') THEN
            EXECUTE 'ALTER TABLE "${t}" ALTER COLUMN org_id DROP NOT NULL';
            EXECUTE 'ALTER TABLE "${t}" DROP CONSTRAINT IF EXISTS "FK_${t}_org_id"';
            EXECUTE 'DROP INDEX IF EXISTS "idx_${t}_org_id"';
          END IF;
        END $$;
      `);
    }
  }
}
