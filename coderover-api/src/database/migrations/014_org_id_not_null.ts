import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 9 / Workstream C — backfill any stragglers and set org_id NOT NULL
 * on the tenant tables. Runs after 013 has ensured memberships exist.
 *
 * Defensive: any row without an org_id gets assigned to the Default org
 * before the ALTER. If there is no Default org (unexpected), a fresh one
 * is created.
 */
export class OrgIdNotNull1713000000014 implements MigrationInterface {
  name = 'OrgIdNotNull1713000000014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantTables = [
      'repos',
      'chat_sessions',
      'agent_runs',
      'pr_reviews',
      'context_artifacts',
      'agent_rules',
      'agent_memory',
    ];

    // Ensure Default org exists
    await queryRunner.query(`
      INSERT INTO organizations (id, name, slug)
      SELECT gen_random_uuid(), 'Default', 'default'
      WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE slug = 'default');
    `);

    for (const t of tenantTables) {
      // Skip tables that don't exist in this deployment
      await queryRunner.query(`
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '${t}' AND column_name = 'org_id'
          ) THEN
            -- backfill any remaining NULLs
            EXECUTE 'UPDATE "${t}" SET "org_id" = (SELECT id FROM organizations WHERE slug = ''default'') WHERE "org_id" IS NULL';
            -- set NOT NULL if it isn't already
            IF EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = '${t}' AND column_name = 'org_id' AND is_nullable = 'YES'
            ) THEN
              EXECUTE 'ALTER TABLE "${t}" ALTER COLUMN "org_id" SET NOT NULL';
            END IF;
          END IF;
        END $$;
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const tenantTables = [
      'repos', 'chat_sessions', 'agent_runs', 'pr_reviews',
      'context_artifacts', 'agent_rules', 'agent_memory',
    ];
    for (const t of tenantTables) {
      await queryRunner.query(`
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '${t}' AND column_name = 'org_id'
          ) THEN
            EXECUTE 'ALTER TABLE "${t}" ALTER COLUMN "org_id" DROP NOT NULL';
          END IF;
        END $$;
      `);
    }
  }
}
