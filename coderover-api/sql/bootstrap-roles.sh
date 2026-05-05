#!/usr/bin/env bash
#
# Phase 5 (Zero Trust) — docker-entrypoint init wrapper.
#
# The pgvector/pgvector image runs every executable script in
# /docker-entrypoint-initdb.d/ on FIRST boot of a fresh data volume
# (see https://hub.docker.com/_/postgres). We mount this script there
# from docker-compose.yml so a `docker compose up` on a clean checkout
# bootstraps the coderover_app + coderover_migrate roles with the
# passwords supplied via env.
#
# This script:
#   1. Reads CODEROVER_APP_PASSWORD / CODEROVER_MIGRATE_PASSWORD from
#      env (set by docker-compose or systemd).
#   2. Runs sql/bootstrap-roles.sql via psql, passing the passwords as
#      psql variables. The .sql file is mounted alongside this one.
#
# Why a wrapper instead of letting Postgres run the .sql directly:
# psql variables (`-v foo=bar`) cannot come from .sql files; they must
# be set on the psql invocation. So we shell-call psql ourselves.
#
# Idempotent: bootstrap-roles.sql guards CREATE ROLE on existence and
# always re-applies password + grants. Re-running rotates passwords
# and reasserts the privilege matrix.

set -euo pipefail

# Phase 5 is opt-in. If the operator left the password vars unset
# (the default in .env.example), skip the bootstrap entirely and let
# Postgres init normally with just the superuser. The api will fall
# back to single-user mode (DATABASE_USER does both runtime + DDL).
# Both vars must be present and non-empty to enable role separation.
if [[ -z "${CODEROVER_APP_PASSWORD:-}" || -z "${CODEROVER_MIGRATE_PASSWORD:-}" ]]; then
  echo "[bootstrap-roles] CODEROVER_APP_PASSWORD / CODEROVER_MIGRATE_PASSWORD unset — skipping (Phase 5 not engaged)"
  exit 0
fi

# POSTGRES_USER + POSTGRES_DB are exposed by the official image to its
# init scripts; default to compose values if missing. We connect via
# unix socket (no -h) so no password is needed for the local
# bootstrap path.
SUPERUSER="${POSTGRES_USER:-postgres}"
DB="${POSTGRES_DB:-coderover}"

echo "[bootstrap-roles] creating coderover_app + coderover_migrate roles in '$DB'"

psql \
  -v ON_ERROR_STOP=1 \
  -v app_password="$CODEROVER_APP_PASSWORD" \
  -v migrate_password="$CODEROVER_MIGRATE_PASSWORD" \
  --username "$SUPERUSER" \
  --dbname "$DB" \
  -f /docker-entrypoint-initdb.d/bootstrap-roles.sql

echo "[bootstrap-roles] done"
