-- Phase 5 (Zero Trust) — DB role separation bootstrap.
--
-- Splits the database into two least-privilege roles:
--
--   coderover_app
--     Runtime user. SELECT/INSERT/UPDATE/DELETE on app tables.
--     NO DDL: cannot CREATE / DROP / ALTER / TRUNCATE. NO superuser.
--     Compromised api credentials cannot drop tables, install
--     extensions, or escalate. This is the user the api process
--     authenticates as.
--
--   coderover_migrate
--     DDL user. Used only by the migration runner (`npm run
--     migration:run` or boot-time auto-migrate). CREATE on schema
--     `public`, full privileges on existing objects. NO superuser.
--
-- Run ONCE per environment as a superuser. Idempotent: re-running
-- updates the passwords and re-applies grants without dropping data.
--
-- Usage: see docs/runbook-db-roles.md for the operator-facing
-- procedure. The short form: connect as a superuser, pass two
-- generated passwords as psql -v variables, and \i this file.
--
-- Then update the api env:
--
--   DATABASE_USER=coderover_app
--   DATABASE_PASSWORD=<the app_password from above>
--   DATABASE_MIGRATE_USER=coderover_migrate
--   DATABASE_MIGRATE_PASSWORD=<the migrate_password from above>
--
-- The api uses DATABASE_USER for runtime queries and switches to
-- DATABASE_MIGRATE_USER (when set) for the boot-time migration step.
-- See database.module.ts.
--
-- Why pre-create extensions here: `coderover_migrate` is intentionally
-- NOT a superuser, but `CREATE EXTENSION` requires superuser. The
-- migrations issue `CREATE EXTENSION IF NOT EXISTS vector` which is a
-- fast no-op once the extension is already installed (PG short-circuits
-- before the privilege check). So we install the extensions ONCE here
-- as a superuser and the non-privileged migration runner sails through.

\set ON_ERROR_STOP on

-- Sanity-check the required psql variables. `:'foo'` quotes as a
-- literal; if unset, psql inserts an empty string and the LENGTH check
-- below trips. Without this, an operator who forgets `-v app_password`
-- would silently create a passwordless role.
SELECT CASE
  WHEN length(:'app_password') < 12
    THEN error_unset_app_password()
  WHEN length(:'migrate_password') < 12
    THEN error_unset_migrate_password()
  ELSE 'ok'
END;
-- ^ The CASE references nonexistent functions on purpose. Postgres
-- only resolves them on the failure branch, so the above succeeds when
-- both vars are set (>= 12 chars) and fails loudly otherwise. Cheap
-- assertion without DO blocks (which can't see psql variables).

-- ────────────────────────────────────────────────────────────────────
-- Roles.
-- ────────────────────────────────────────────────────────────────────

-- CREATE ROLE has no `IF NOT EXISTS` — emulate via \gexec on a guarded
-- SELECT. The format() escaping matches PG's own quote_literal, so a
-- password containing single quotes is handled correctly.

SELECT format('CREATE ROLE coderover_app LOGIN PASSWORD %L', :'app_password')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coderover_app')
\gexec

SELECT format('CREATE ROLE coderover_migrate LOGIN PASSWORD %L', :'migrate_password')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coderover_migrate')
\gexec

-- Always reset passwords so re-running with new psql vars rotates them.
SELECT format('ALTER ROLE coderover_app WITH LOGIN PASSWORD %L', :'app_password')
\gexec

SELECT format('ALTER ROLE coderover_migrate WITH LOGIN PASSWORD %L', :'migrate_password')
\gexec

-- Belt and braces — neither role should ever be a superuser, bypass
-- RLS, or be allowed to create roles/databases. Reasserting in case
-- this script runs against a DB where someone manually granted these.
ALTER ROLE coderover_app     NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;
ALTER ROLE coderover_migrate NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;

-- ────────────────────────────────────────────────────────────────────
-- Extensions (must be done as superuser, before privilege grants).
-- ────────────────────────────────────────────────────────────────────

-- pgvector is the only non-built-in we use. `gen_random_uuid()` is
-- built into Postgres 13+, no pgcrypto needed.
CREATE EXTENSION IF NOT EXISTS vector;

-- ────────────────────────────────────────────────────────────────────
-- Schema-level privileges.
-- ────────────────────────────────────────────────────────────────────

-- Default-deny: yank the implicit CREATE-on-schema-public from PUBLIC.
-- Postgres 15+ already does this on fresh databases, but older clusters
-- and pg_dump-restored DBs may still have the legacy grant. Idempotent.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT USAGE  ON SCHEMA public TO coderover_app, coderover_migrate;
GRANT CREATE ON SCHEMA public TO coderover_migrate;

-- ────────────────────────────────────────────────────────────────────
-- Grants on existing objects (CRUD for app, ALL for migrate).
-- ────────────────────────────────────────────────────────────────────

-- coderover_app — runtime CRUD only.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO coderover_app;
GRANT USAGE, SELECT, UPDATE          ON ALL SEQUENCES IN SCHEMA public TO coderover_app;
GRANT EXECUTE                         ON ALL FUNCTIONS IN SCHEMA public TO coderover_app;

-- coderover_migrate — full DDL/DML.
GRANT ALL ON ALL TABLES    IN SCHEMA public TO coderover_migrate;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO coderover_migrate;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO coderover_migrate;

-- ────────────────────────────────────────────────────────────────────
-- Default privileges for FUTURE objects created by coderover_migrate.
--
-- Without this, every new migration would have to manually GRANT to
-- coderover_app or the api would 500 on day-one queries. With
-- ALTER DEFAULT PRIVILEGES, every CREATE TABLE the migration runner
-- issues automatically grants CRUD to coderover_app.
-- ────────────────────────────────────────────────────────────────────

ALTER DEFAULT PRIVILEGES FOR ROLE coderover_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO coderover_app;

ALTER DEFAULT PRIVILEGES FOR ROLE coderover_migrate IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO coderover_app;

ALTER DEFAULT PRIVILEGES FOR ROLE coderover_migrate IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO coderover_app;
