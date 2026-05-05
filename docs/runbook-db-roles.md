# DB role separation — operator runbook

Phase 5 target: stop the api from connecting to Postgres as a superuser.
The runtime user gets CRUD only; a dedicated migrate user gets DDL only;
`postgres` becomes a bootstrap-and-break-glass role nothing connects as
day-to-day.

This document is the one-time setup procedure per environment, plus the
"how do I rotate / debug" cheatsheet. The role-creation script lives at
`coderover-api/sql/bootstrap-roles.sql` and runs as a superuser. The api
then authenticates as `coderover_app` for normal queries and switches
to `coderover_migrate` only for the migration step on boot (see
`DatabaseModule` in `coderover-api/src/database/database.module.ts`).

---

## What this gets you

| Threat | Pre-Phase-5 (DATABASE_USER=postgres) | Post-Phase-5 (DATABASE_USER=coderover_app) |
|---|---|---|
| api creds leaked → DROP TABLE | possible | blocked (no DDL grant) |
| api creds leaked → CREATE EXTENSION malicious | possible | blocked (not superuser) |
| api creds leaked → CREATE ROLE escalation | possible | blocked (NOCREATEROLE) |
| api creds leaked → SELECT/INSERT app data | possible | possible (this is the runtime privilege) |
| Migration runner needs DDL | uses superuser | uses dedicated `coderover_migrate` |

The runtime credential blast radius shrinks from "anything Postgres can
do" to "data-plane queries on the app schema". DDL stays gated behind
the migrate credential which only ever lives on the deploy host.

## Two roles

- **`coderover_app`** — runtime user. `LOGIN`, `NOSUPERUSER`,
  `NOCREATEROLE`, `NOCREATEDB`, `NOBYPASSRLS`. Granted
  `SELECT, INSERT, UPDATE, DELETE` on tables, `USAGE, SELECT, UPDATE`
  on sequences, `EXECUTE` on functions in schema `public`. No `CREATE`
  on schema. This is what `DATABASE_USER` becomes.

- **`coderover_migrate`** — DDL user. Same `NOSUPERUSER` /
  `NOCREATEROLE` flags. Granted `CREATE` on schema `public` and `ALL`
  on existing objects. Used by `npm run migration:run` and the
  boot-time auto-migrate path. This is what `DATABASE_MIGRATE_USER`
  becomes.

`ALTER DEFAULT PRIVILEGES` is configured so any table/sequence/function
`coderover_migrate` creates in the future automatically grants the
right CRUD subset to `coderover_app`. New migrations don't need to
remember to GRANT — the schema does it for them.

## First-time setup (per environment)

You need:

- A Postgres superuser credential (typically `postgres`) you can
  connect with **once** to bootstrap roles.
- Two random passwords — one for `coderover_app`, one for
  `coderover_migrate`. Store them in your secrets manager.

```bash
APP_PW=$(openssl rand -base64 32)
MIGRATE_PW=$(openssl rand -base64 32)

# Run the bootstrap. Idempotent: re-running rotates passwords.
# PGPASSWORD keeps the superuser password out of the shell command line
# (and out of `ps` / shell history).
PGPASSWORD="$SUPERUSER_PW" psql \
  -h db.internal -p 5432 -U postgres -d coderover \
  -v ON_ERROR_STOP=1 \
  -v app_password="$APP_PW" \
  -v migrate_password="$MIGRATE_PW" \
  -f coderover-api/sql/bootstrap-roles.sql
```

Then update the api environment:

```bash
DATABASE_USER=coderover_app
DATABASE_PASSWORD=$APP_PW
DATABASE_MIGRATE_USER=coderover_migrate
DATABASE_MIGRATE_PASSWORD=$MIGRATE_PW
```

Restart the api. On the next boot:

- `DatabaseModule` sees `DATABASE_MIGRATE_USER` is set and opens a
  one-shot DataSource as `coderover_migrate` to run any pending
  migrations.
- After migrations land, the runtime DataSource opens as
  `coderover_app` and stays open.

## docker-compose (dev)

For local dev, the compose file mounts `sql/bootstrap-roles.sh` into
the postgres container's `/docker-entrypoint-initdb.d/`. Postgres'
official image runs init scripts on FIRST boot of a fresh pgdata volume
and skips them on subsequent restarts.

In `coderover-api/.env`:

```bash
CODEROVER_APP_PASSWORD=$(openssl rand -base64 32)
CODEROVER_MIGRATE_PASSWORD=$(openssl rand -base64 32)
DATABASE_USER=coderover_app
DATABASE_PASSWORD=<same as CODEROVER_APP_PASSWORD>
DATABASE_MIGRATE_USER=coderover_migrate
DATABASE_MIGRATE_PASSWORD=<same as CODEROVER_MIGRATE_PASSWORD>
```

Then:

```bash
docker compose down -v   # WIPE pgdata so init scripts re-run
docker compose up -d postgres
docker compose logs postgres | grep bootstrap-roles
# expected: "[bootstrap-roles] creating coderover_app + coderover_migrate roles in 'coderover'"
# expected: "[bootstrap-roles] done"
docker compose up -d api
```

If you want to keep your existing pgdata volume and just add the roles,
run the bootstrap manually instead:

```bash
docker compose exec postgres psql \
  -v ON_ERROR_STOP=1 \
  -v app_password="$CODEROVER_APP_PASSWORD" \
  -v migrate_password="$CODEROVER_MIGRATE_PASSWORD" \
  -U postgres -d coderover \
  -f /docker-entrypoint-initdb.d/bootstrap-roles.sql
```

## Falling back (skip Phase 5)

Both `DATABASE_MIGRATE_USER` and `DATABASE_MIGRATE_PASSWORD` are
optional. Leave them blank and the app reverts to pre-Phase-5
behavior — migrations run as `DATABASE_USER`, which on a `postgres`
superuser works fine. Useful for dev/CI that doesn't want to manage
two credentials.

## Verifying the split

After setup:

```bash
# coderover_app cannot DDL
PGPASSWORD=$APP_PW psql -h db.internal -U coderover_app -d coderover \
  -c "CREATE TABLE foo (x int);"
# ERROR:  permission denied for schema public

# coderover_app can CRUD
PGPASSWORD=$APP_PW psql -h db.internal -U coderover_app -d coderover \
  -c "SELECT count(*) FROM repos;"
# returns a count

# coderover_migrate can DDL
PGPASSWORD=$MIGRATE_PW psql -h db.internal -U coderover_migrate -d coderover \
  -c "CREATE TABLE _phase5_smoke (x int); DROP TABLE _phase5_smoke;"
# returns CREATE TABLE / DROP TABLE
```

## Rotating passwords

Re-run the bootstrap with the new password values. The script always
issues `ALTER ROLE … WITH PASSWORD …` regardless of whether the role
existed, so the old password is replaced atomically.

```bash
APP_PW_NEW=$(openssl rand -base64 32)
psql … -v app_password="$APP_PW_NEW" -v migrate_password="$MIGRATE_PW" \
  -f coderover-api/sql/bootstrap-roles.sql
# update DATABASE_PASSWORD in the api env, restart.
```

## Adding new tables

You don't need to do anything. `ALTER DEFAULT PRIVILEGES FOR ROLE
coderover_migrate IN SCHEMA public GRANT … TO coderover_app` already
covers any tables/sequences/functions the migration runner creates.
The grant takes effect at CREATE TABLE time, not retroactively, so
this only applies to FUTURE objects — existing tables were granted
explicitly when bootstrap-roles.sql ran.

If a migration creates objects in a non-`public` schema, you'll need
to add a parallel `ALTER DEFAULT PRIVILEGES … IN SCHEMA <name>` block
to the bootstrap script for that schema.

## Break-glass

The `postgres` superuser still exists; use it for emergency
investigation (`psql -U postgres -d coderover` from the db host).
Day-to-day app traffic does NOT authenticate as postgres — if you see
`postgres` in `pg_stat_activity` from the api, something is
misconfigured.

```sql
-- "what's connected right now and as which user?"
SELECT usename, application_name, count(*)
FROM pg_stat_activity
WHERE datname = 'coderover'
GROUP BY 1, 2
ORDER BY count(*) DESC;
```

Expected: `coderover_app` rows from the api process, optionally
`coderover_migrate` during a deploy migration. `postgres` only when
you're actively running the bootstrap or doing forensics.
