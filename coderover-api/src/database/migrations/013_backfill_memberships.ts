import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 9 / Workstream C — backfill: auto-assign every existing user as
 * an owner of the Default organization so their newly-issued tokens
 * carry a valid orgId. Safe to re-run (INSERT ... ON CONFLICT DO NOTHING).
 */
export class BackfillMemberships1713000000013 implements MigrationInterface {
  name = 'BackfillMemberships1713000000013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE default_org_id uuid;
      BEGIN
        SELECT id INTO default_org_id FROM organizations WHERE slug = 'default' LIMIT 1;
        IF default_org_id IS NULL THEN
          INSERT INTO organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'Default', 'default')
          RETURNING id INTO default_org_id;
        END IF;

        INSERT INTO org_memberships (org_id, user_id, role)
        SELECT default_org_id, u.id, 'owner'
        FROM users u
        ON CONFLICT (org_id, user_id) DO NOTHING;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No-op: we don't remove memberships on rollback to avoid losing
    // explicit invitations. Drop the membership table via migration 011.down
    // if a full tear-down is required.
  }
}
