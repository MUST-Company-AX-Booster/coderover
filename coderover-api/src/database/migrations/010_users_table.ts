import { MigrationInterface, QueryRunner } from 'typeorm';

export class UsersTable1713000000010 implements MigrationInterface {
  name = 'UsersTable1713000000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create enum type if not exists
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE user_role AS ENUM ('admin', 'user');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        "email" varchar NOT NULL UNIQUE,
        "name" varchar,
        "passwordHash" varchar,
        "role" user_role NOT NULL DEFAULT 'user',
        "githubId" varchar,
        "refreshToken" varchar,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_email" ON "users" ("email");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "users";`);
  }
}
