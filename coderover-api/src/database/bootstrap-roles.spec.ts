import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Phase 5 (Zero Trust) — structural test on the role bootstrap SQL.
 *
 * We can't reasonably stand up a Postgres in unit tests just to verify
 * the grant matrix, but the SQL is a contract: it has to create both
 * roles, lock them down to non-superuser, and grant the exact
 * privilege subset we documented in the runbook. Drift here means
 * either a privilege escalation (too many grants) or a runtime outage
 * (missing grants). Both are silent in code review without an
 * assertion.
 *
 * Asserts that:
 *   - both roles are CREATEd with conditional NOT EXISTS,
 *   - passwords come from psql variables (`:'app_password'` etc.),
 *   - both roles are forced NOSUPERUSER + NOCREATEROLE,
 *   - the grant matrix is what the runbook promises,
 *   - default privileges for future tables are wired,
 *   - REVOKE PUBLIC's CREATE-on-schema runs.
 *
 * Plain string-contains checks — anything more sophisticated would
 * just be re-implementing a SQL parser. If a developer reorganizes the
 * file, this test breaks loudly and forces an explicit re-review.
 */
// Lives in src/database/ (so the project's jest rootDir picks it up)
// but the SQL it asserts on lives at coderover-api/sql/ — operators
// look there for the bootstrap script. The relative climb is fine
// because both the .ts test and the .sql asset are checked in
// alongside each other.
const BOOTSTRAP_SQL_PATH = join(__dirname, '..', '..', 'sql', 'bootstrap-roles.sql');

describe('bootstrap-roles.sql', () => {
  const sql = readFileSync(BOOTSTRAP_SQL_PATH, 'utf8');

  describe('role creation', () => {
    it('creates coderover_app conditionally on non-existence', () => {
      // The CREATE ROLE … WHERE NOT EXISTS pattern via \gexec — no
      // CREATE OR REPLACE for roles in PG, so we emulate idempotency.
      expect(sql).toMatch(
        /CREATE ROLE coderover_app LOGIN PASSWORD %L[\s\S]*?WHERE NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'coderover_app'\)/,
      );
    });

    it('creates coderover_migrate conditionally on non-existence', () => {
      expect(sql).toMatch(
        /CREATE ROLE coderover_migrate LOGIN PASSWORD %L[\s\S]*?WHERE NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'coderover_migrate'\)/,
      );
    });

    it('always re-applies passwords on every run (rotation path)', () => {
      // ALTER ROLE … WITH LOGIN PASSWORD … runs unconditionally —
      // this is what makes re-running the script with new psql vars
      // rotate the passwords.
      expect(sql).toMatch(
        /ALTER ROLE coderover_app WITH LOGIN PASSWORD %L/,
      );
      expect(sql).toMatch(
        /ALTER ROLE coderover_migrate WITH LOGIN PASSWORD %L/,
      );
    });

    it('uses %L (literal-quoted) for password injection, not %s', () => {
      // %L escapes single quotes properly; %s would be a SQLi risk if
      // a password contained one. Belt-and-braces — the password is
      // already trusted (operator-supplied) but we should assume
      // adversarial input.
      expect(sql).not.toMatch(/PASSWORD %s/);
    });
  });

  describe('role hardening', () => {
    it('forces coderover_app to NOSUPERUSER + NOCREATEROLE + NOCREATEDB + NOBYPASSRLS + NOREPLICATION', () => {
      // All five flags assert defense-in-depth: even if some other
      // operator manually granted SUPERUSER, this script reasserts.
      expect(sql).toMatch(
        /ALTER ROLE coderover_app\s+NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION/,
      );
    });

    it('forces coderover_migrate to NOSUPERUSER + NOCREATEROLE + NOCREATEDB + NOBYPASSRLS + NOREPLICATION', () => {
      expect(sql).toMatch(
        /ALTER ROLE coderover_migrate\s+NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION/,
      );
    });
  });

  describe('extension setup', () => {
    it('creates the pgvector extension before grants run', () => {
      // Must run as superuser; non-superuser migrate role would fail
      // a real CREATE EXTENSION but `IF NOT EXISTS` on an
      // already-installed extension is a fast no-op even for
      // non-superusers, so this single bootstrap step covers it.
      expect(sql).toMatch(/CREATE EXTENSION IF NOT EXISTS vector/);

      const extensionIdx = sql.indexOf('CREATE EXTENSION');
      const grantIdx = sql.indexOf('GRANT SELECT, INSERT');
      expect(extensionIdx).toBeGreaterThan(0);
      expect(grantIdx).toBeGreaterThan(extensionIdx);
    });
  });

  describe('schema-level grants', () => {
    it('revokes CREATE on schema public from PUBLIC (default-deny)', () => {
      // Postgres 15+ already does this on fresh DBs, but legacy
      // clusters and pg_dump-restored DBs may still have the
      // implicit public grant. Idempotent reassertion.
      expect(sql).toMatch(/REVOKE CREATE ON SCHEMA public FROM PUBLIC/);
    });

    it('grants USAGE on schema public to both roles', () => {
      expect(sql).toMatch(
        /GRANT USAGE\s+ON SCHEMA public TO coderover_app, coderover_migrate/,
      );
    });

    it('grants CREATE on schema public to coderover_migrate only', () => {
      expect(sql).toMatch(/GRANT CREATE ON SCHEMA public TO coderover_migrate/);
      // Make sure we did NOT grant CREATE-on-schema to the app role.
      expect(sql).not.toMatch(
        /GRANT CREATE ON SCHEMA public TO coderover_app(?!,)/,
      );
      expect(sql).not.toMatch(
        /GRANT CREATE ON SCHEMA public TO[^;]*coderover_app/,
      );
    });
  });

  describe('object-level grants on existing tables', () => {
    it('grants exactly SELECT/INSERT/UPDATE/DELETE on tables to coderover_app', () => {
      // No TRUNCATE, no REFERENCES, no TRIGGER for the runtime user.
      expect(sql).toMatch(
        /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES\s+IN SCHEMA public TO coderover_app/,
      );
    });

    it('grants USAGE/SELECT/UPDATE on sequences to coderover_app (covers nextval/setval)', () => {
      // UPDATE is required for setval(); USAGE+SELECT for nextval().
      // The TypeORM driver triggers nextval() on insert when the
      // column has a sequence default.
      expect(sql).toMatch(
        /GRANT USAGE, SELECT, UPDATE\s+ON ALL SEQUENCES IN SCHEMA public TO coderover_app/,
      );
    });

    it('grants EXECUTE on functions to coderover_app (covers gen_random_uuid)', () => {
      expect(sql).toMatch(
        /GRANT EXECUTE\s+ON ALL FUNCTIONS IN SCHEMA public TO coderover_app/,
      );
    });

    it('grants ALL on tables/sequences/functions to coderover_migrate', () => {
      expect(sql).toMatch(
        /GRANT ALL ON ALL TABLES\s+IN SCHEMA public TO coderover_migrate/,
      );
      expect(sql).toMatch(
        /GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO coderover_migrate/,
      );
      expect(sql).toMatch(
        /GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO coderover_migrate/,
      );
    });
  });

  describe('default privileges for future objects', () => {
    it('auto-grants CRUD to coderover_app on tables created by coderover_migrate', () => {
      // Without this, every new migration would have to remember to
      // GRANT … TO coderover_app or the api would 500 on day-one
      // queries against the new table. ALTER DEFAULT PRIVILEGES is
      // role-scoped: only objects created by coderover_migrate
      // inherit, which is exactly what we want.
      expect(sql).toMatch(
        /ALTER DEFAULT PRIVILEGES FOR ROLE coderover_migrate IN SCHEMA public\s+GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO coderover_app/,
      );
    });

    it('auto-grants USAGE/SELECT/UPDATE on future sequences', () => {
      expect(sql).toMatch(
        /ALTER DEFAULT PRIVILEGES FOR ROLE coderover_migrate IN SCHEMA public\s+GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO coderover_app/,
      );
    });

    it('auto-grants EXECUTE on future functions', () => {
      expect(sql).toMatch(
        /ALTER DEFAULT PRIVILEGES FOR ROLE coderover_migrate IN SCHEMA public\s+GRANT EXECUTE ON FUNCTIONS TO coderover_app/,
      );
    });
  });

  describe('input validation', () => {
    it('aborts on missing or short app_password', () => {
      // The CASE-references-nonexistent-function trick — Postgres
      // only resolves the failure branch, so the assertion fails
      // loudly when the psql var is unset/empty/short.
      expect(sql).toMatch(/length\(:'app_password'\) < 12/);
      expect(sql).toMatch(/error_unset_app_password\(\)/);
    });

    it('aborts on missing or short migrate_password', () => {
      expect(sql).toMatch(/length\(:'migrate_password'\) < 12/);
      expect(sql).toMatch(/error_unset_migrate_password\(\)/);
    });

    it('sets ON_ERROR_STOP so a failed grant aborts the script', () => {
      expect(sql).toMatch(/\\set ON_ERROR_STOP on/);
    });
  });
});
