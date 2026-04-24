#!/usr/bin/env bash
#
# prepublish-smoke.sh
# -------------------
# Runs `npm pack`, installs the resulting tarball into a throwaway
# dir, and exercises the installed CLI end-to-end. Wired into the
# `prepublishOnly` npm script so a broken artifact (missing dist file,
# `files` manifest typo, broken bin shim) can't reach the registry.
#
# The in-tree `test/main.spec.ts` already smoke-tests `main()` against
# working-tree sources — this script adds the layer that catches
# *packaging* regressions: the shape of the tarball, not the source.
#
# Checks:
#   1. `--version` prints the expected semver.
#   2. `--help` includes every top-level subcommand.
#   3. Remote-mode boot with no env prints a clean error and exits 2
#      (not a stack trace, not 0).
#   4. Local-mode boot with no DB prints the local-mode error and
#      exits 2. This is the exact failure mode that shipped broken in
#      0.2.1 — guarding it here prevents recurrence pre-publish.
#
# Runs in ~10s on a warm npm cache. Cleans up after itself on success
# and failure.

set -euo pipefail

# This script exists specifically to work even when invoked from inside
# `npm publish --dry-run`'s prepublishOnly hook. npm's publish machinery
# exports `npm_config_dry_run=true` (and friends) to lifecycle children,
# which neutralizes `npm pack` AND `npm install` — turning our whole
# smoke into silent no-ops that still exit 0. Unset the whole class of
# dry-run config here so every downstream npm call behaves normally.
unset npm_config_dry_run
unset npm_config_dry_run_name  # some npm versions alias under this

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PKG_DIR"

say() { printf '[smoke] %s\n' "$*"; }
fail() { printf '[smoke] FAIL: %s\n' "$*" >&2; exit 1; }

TMP="$(mktemp -d -t coderover-mcp-smoke-XXXXXX)"
trap '[ -n "${TMP:-}" ] && rm -rf "$TMP"' EXIT

# Pack into the tempdir, not the package dir. When this script runs as
# part of `npm publish`'s prepublishOnly hook, npm itself is orchestrating
# a pack of the package in $PKG_DIR — writing our own tarball there
# races with npm's workflow (ENOENT mid-install). Writing to $TMP
# keeps the two workflows independent.
#
say "packing tarball into $TMP"
TARBALL_NAME="$(npm pack --silent --pack-destination "$TMP")"
TARBALL="$TMP/$TARBALL_NAME"
[ -f "$TARBALL" ] || fail "expected tarball at $TARBALL, not found"

INSTALL_DIR="$TMP/install"
mkdir -p "$INSTALL_DIR"
say "installing $TARBALL_NAME into $INSTALL_DIR"
cd "$INSTALL_DIR"
npm init -y >/dev/null
# --silent here still prints the audit summary; redirect everything we
# don't care about while preserving real errors via the exit code.
if ! npm install --silent "$TARBALL" >/dev/null 2>&1; then
  fail "npm install of the packed tarball failed"
fi

# Invoke the installed bin directly by its node entry. `npx` is unreliable
# here: under `npm publish`'s prepublishOnly the npx cache can resolve a
# different (previously-published) version of @coderover/mcp, making the
# smoke exercise yesterday's artifact instead of today's. Going through
# `node <path-to-bin>` pins it to the freshly-installed tarball.
BIN_SCRIPT="$INSTALL_DIR/node_modules/@coderover/mcp/bin/coderover-mcp.js"
[ -f "$BIN_SCRIPT" ] || fail "installed bin not found at $BIN_SCRIPT"
BIN=(node "$BIN_SCRIPT")

# ─── 1. --version ────────────────────────────────────────────────────
say "check: --version"
EXPECTED="$(node -p "require('$PKG_DIR/package.json').version")"
GOT="$("${BIN[@]}" --version)"
[ "$GOT" = "$EXPECTED" ] || fail "--version = $GOT, expected $EXPECTED"
say "  ✓ $GOT"

# ─── 2. --help ───────────────────────────────────────────────────────
say "check: --help lists every subcommand"
HELP="$("${BIN[@]}" --help)"
for sub in install uninstall doctor upgrade index reindex watch list clean; do
  case "$HELP" in
    *"coderover-mcp $sub"*) ;;
    *) fail "--help is missing subcommand \"$sub\"" ;;
  esac
done
say "  ✓ help complete"

# ─── 3. remote-mode missing-env path ─────────────────────────────────
say "check: remote-mode boot fails cleanly with no env"
# Unset env that could leak in from the developer's shell.
set +e
OUT="$(env -u CODEROVER_API_URL -u CODEROVER_API_TOKEN -u CODEROVER_MODE -u CODEROVER_LOCAL_DB "${BIN[@]}" 2>&1)"
CODE=$?
set -e
case "$OUT" in
  *"CODEROVER_API_URL is required"*) ;;
  *) fail "unexpected remote-mode error text:\n$OUT" ;;
esac
[ "$CODE" = "2" ] || fail "remote-mode exit code = $CODE, expected 2"
say "  ✓ exits 2 with a clean error"

# ─── 4. local-mode missing-DB path ───────────────────────────────────
# This is the exact regression that shipped in 0.2.1. Before the fix,
# CODEROVER_MODE=local still entered the remote-mode branch and asked
# for CODEROVER_API_URL. After the fix it demands CODEROVER_LOCAL_DB.
say "check: local-mode boot demands CODEROVER_LOCAL_DB"
set +e
OUT="$(env -u CODEROVER_API_URL -u CODEROVER_API_TOKEN -u CODEROVER_LOCAL_DB CODEROVER_MODE=local "${BIN[@]}" 2>&1)"
CODE=$?
set -e
case "$OUT" in
  *"CODEROVER_LOCAL_DB is required"*) ;;
  *)
    fail "local-mode did NOT report CODEROVER_LOCAL_DB; did the 0.2.1 regression return?\n$OUT"
    ;;
esac
[ "$CODE" = "2" ] || fail "local-mode exit code = $CODE, expected 2"
say "  ✓ exits 2 with local-mode error"

say "OK — prepublish smoke passed"
