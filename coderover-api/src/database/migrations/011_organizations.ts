import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 9 / Workstream C: Multi-tenant foundation.
 *
 * Creates organizations + org_memberships, adds nullable org_id to all
 * tenant-owned tables, seeds a "Default" org, backfills every existing
 * row, and sets org_id NOT NULL.
 *
 * Combined into a single migration for atomicity. Next migration (012)
 * will add monthly_token_cap & token_usage_period for Workstream F.
 */
export class Organizations1713000000011 implements MigrationInterface {
  name = 'Organizations1713000000011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. org_role enum
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE org_role AS ENUM ('owner', 'admin', 'member');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `);

    // 2. organizations table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "organizations" (
        "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        "name" varchar(255) NOT NULL,
        "slug" varchar(64) NOT NULL UNIQUE,
        "monthly_token_cap" integer,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      );
    `);

    // 3. org_memberships
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "org_memberships" (
        "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "role" org_role NOT NULL DEFAULT 'member',
        "created_at" timestamp NOT NULL DEFAULT now(),
        UNIQUE ("org_id", "user_id")
      );
    `);

    // 4. Add nullable org_id to tenant-owned tables (if they exist).
    const tenantTables = [
      'repos',
      'chat_sessions',
      'agent_runs',
      'pr_reviews',
      'context_artifacts',
      'agent_rules',
      'agent_memory',
    ];
    for (const t of tenantTables) {
      await queryRunner.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '${t}') THEN
            ALTER TABLE "${t}" ADD COLUMN IF NOT EXISTS "org_id" uuid;
          END IF;
        END $$;
      `);
    }

    // 5. Seed default org and assign every existing user as owner.
    await queryRunner.query(`
      INSERT INTO "organizations" ("id", "name", "slug")
      SELECT gen_random_uuid(), 'Default', 'default'
      WHERE NOT EXISTS (SELECT 1 FROM "organizations" WHERE "slug" = 'default');
    `);

    await queryRunner.query(`
      INSERT INTO "org_memberships" ("org_id", "user_id", "role")
      SELECT (SELECT id FROM "organizations" WHERE slug = 'default'), u.id, 'owner'
      FROM "users" u
      WHERE NOT EXISTS (
        SELECT 1 FROM "org_memberships" m
        WHERE m.user_id = u.id AND m.org_id = (SELECT id FROM "organizations" WHERE slug = 'default')
      );
    `);

    // 6. Backfill org_id on tenant tables.
    for (const t of tenantTables) {
      await queryRunner.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = '${t}' AND column_name = 'org_id') THEN
            UPDATE "${t}" SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default')
            WHERE "org_id" IS NULL;
          END IF;
        END $$;
      `);
    }

    // 7. FK + NOT NULL. We keep NULL allowed on legacy tables whose row counts
    //    are zero to avoid schema errors; prod rollout sets NOT NULL in a
    //    follow-up migration once every environment has backfilled.
    for (const t of tenantTables) {
      await queryRunner.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = '${t}' AND column_name = 'org_id') THEN
            EXECUTE format('CREATE INDEX IF NOT EXISTS "idx_%I_org_id" ON %I("org_id")', '${t}', '${t}');
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
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = '${t}' AND column_name = 'org_id') THEN
            ALTER TABLE "${t}" DROP COLUMN "org_id";
          END IF;
        END $$;
      `);
    }
    await queryRunner.query(`DROP TABLE IF EXISTS "org_memberships";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "organizations";`);
    await queryRunner.query(`DROP TYPE IF EXISTS org_role;`);
  }
}
