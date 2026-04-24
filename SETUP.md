# CodeRover — Setup Guide

First-run setup for design partners and new contributors. If you already ran
Phase 9 once and just want to pick up the Phase 10 additions (MCP, confidence
tags, watch daemon, benchmarks), skip to the
[Phase 10 add-ons](#phase-10-add-ons) section.

See also:
- [`ROADMAP.md`](./ROADMAP.md) — what shipped in Phase 10 and what's coming next.
- [`CHANGELOG.md`](./CHANGELOG.md) — migration notes and deprecations.
- [`docs/runbook-phase10.md`](./docs/runbook-phase10.md) — Phase 10 ops / oncall runbook.
- [`docs/runbook-phase9.md`](./docs/runbook-phase9.md) —
  Phase 9 ops surfaces (OTel, Prometheus, token caps, rollback).

---

## Prerequisites

| Tool          | Version    | Notes                                                          |
| ------------- | ---------- | -------------------------------------------------------------- |
| Node.js       | 18.17+     | The `@coderover/mcp` package pins `engines.node >= 18.17`.     |
| npm           | 9+         | Ships with Node 18+.                                           |
| Docker        | 24+        | For the local infra stack.                                     |
| Docker Compose| v2         | `docker compose` (space, not hyphen).                          |
| Git           | 2.40+      | Required for ingest; `coderover watch` honors `.gitignore`.    |

The backing services are pinned in
[`coderover-api/docker-compose.yml`](./coderover-api/docker-compose.yml):

- **Postgres 16 + pgvector** on port `5434` (host) → `5432` (container).
- **Redis 7** on port `6380` (host) → `6379` (container).
- **Memgraph** (memgraph-mage) on ports `7687` (Bolt) and `7444` (Lab).

The plan spec asks for Postgres 15 / Redis 7 / Memgraph 2.x — the shipped
compose file pins Postgres 16 (pgvector image) and Memgraph's `mage` tag; both
versions are backward compatible with the migrations and queries we run.

---

## 1. Backend (API)

```bash
git clone <this repo>
cd coderover/coderover-api

# Bring up infra.
docker compose up -d

# Configure. Edit the file after copying — at minimum set the four vars
# called out below.
cp .env.example .env

# Install + run migrations. Migrations 020–023 are Phase 10 additions; see
# CHANGELOG for details.
npm install
npm run migration:run

# Dev server (port 3001).
npm run start:dev
```

### Minimum `.env`

```
# Auth — JWT signing, AES-256-GCM for secret rows in system_settings.
JWT_SECRET=<32+ chars>
SETTINGS_ENCRYPTION_KEY=<base64, 32 bytes>    # openssl rand -base64 32

# Database (matches docker-compose.yml).
DATABASE_HOST=localhost
DATABASE_PORT=5434
DATABASE_NAME=coderover
DATABASE_USER=postgres
DATABASE_PASSWORD=postgres

# Redis — Phase 10 C1 ContentCacheService uses this for the hash index.
REDIS_HOST=localhost
REDIS_PORT=6380

# Memgraph — required for the code graph + Phase 10 confidence edges.
MEMGRAPH_URI=bolt://localhost:7687

# LLM provider. Pick one of:
#   - OpenAI:     OPENAI_API_KEY=sk-...           LLM_PROVIDER=openai
#   - OpenRouter: OPENAI_API_KEY=sk-or-...        LLM_PROVIDER=openrouter
#                 OPENAI_BASE_URL=https://openrouter.ai/api/v1
#   - Local:      LLM_PROVIDER=local               (point OPENAI_BASE_URL at Ollama/LM Studio)
OPENAI_API_KEY=sk-...
LLM_PROVIDER=openai

# GitHub OAuth (required for the in-app repo picker — Phase 3 unified flow).
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=http://localhost:3001/auth/github/callback
FRONTEND_APP_URL=http://localhost:5173
```

The full variable reference — optional flags, defaults, and agent tuning —
lives in [`coderover-api/.env.example`](./coderover-api/.env.example). Swagger
is auto-exposed in dev at http://localhost:3001/api-docs and gated with Basic
auth in prod when `SWAGGER_USERNAME` / `SWAGGER_PASSWORD` are set.

### Migrations

`npm run migration:run` applies everything through migration 023:

| Migration                                 | What it does                                   |
| ----------------------------------------- | ---------------------------------------------- |
| `001`–`019`                               | Phase 1–9 schema (see CHANGELOG for history).  |
| `020_phase10_confidence_schema`           | `confidence_tag` enum + `rag_citations`, `pr_review_findings`, `edge_producer_audit`, `graph_migrations` tables. |
| `021_phase10_backfill_confidence_defaults`| One-time `AMBIGUOUS` default for legacy rows.  |
| `022_revoked_tokens`                      | MCP token issuance + revocation table.          |
| `023_cache_metadata`                      | `cache_entries` table for ContentCache LRU.    |

`graph_migrations` is a tracker table — the first time the API boots after
020 lands, a one-time Cypher migration stamps `AMBIGUOUS` on every existing
Memgraph edge. This is additive-safe and re-runnable.

### First-repo ingest

1. Register an account at http://localhost:5173/register, then log in.
2. Repositories → Add Repository. Paste a GitHub URL (public or one you have a
   token for).
3. The backend kicks off AST + embedding + graph ingestion. Phase 10 C2 makes
   this incremental — second runs re-process only changed files.

---

## 2. Frontend

```bash
cd coderover-frontend
npm install
npm run dev
```

Visit http://localhost:5173. The Phase 10 B3 additions (`ConfidenceMark` pill,
`GraphConfidenceLegend`) render automatically on the Chat, PR Reviews, and
Graph pages once the backend is on migration 023+.

Build for production:

```bash
npm run build && npm run preview
```

---

## 3. MCP install (for AI assistants)

Phase 10 A1–A3 ships `@coderover/mcp` — a standalone Node package that exposes
the CodeRover tool surface to any MCP-compatible agent. Install it into each
agent's config with one `npx` command:

```bash
# Claude Code (Anthropic).
npx @coderover/mcp@latest install claude-code

# Cursor.
npx @coderover/mcp@latest install cursor

# Aider.
npx @coderover/mcp@latest install aider

# Codex (OpenAI CLI).
npx @coderover/mcp@latest install codex

# Gemini CLI.
npx @coderover/mcp@latest install gemini-cli
```

Each installer writes an atomic update to the target agent's config file
(`~/.config/claude-code/mcp.json`, `~/.cursor/config.json`, etc. — see
`packages/mcp/src/installer/agents/`). Restart the agent after install so it
re-reads the config.

### Getting a token

```bash
# Ask the admin UI for a scoped MCP token — or mint one via the API.
curl -X POST http://localhost:3001/auth/tokens \
  -H "Authorization: Bearer $USER_JWT" \
  -H "Content-Type: application/json" \
  -d '{"scope":["search:read","citations:read","graph:read"],"kind":"mcp","label":"my-laptop"}'
```

The installer prompts for `CODEROVER_API_URL` and `CODEROVER_API_TOKEN` and
writes them into the agent config. Tokens can be revoked at any time — see
the Phase 10 runbook for the revocation flow.

### Verifying the install

```bash
# Hits GET /mcp/capabilities — the same handshake the client performs.
curl -s http://localhost:3001/mcp/capabilities | jq .

# A3 `doctor` walks through token, backend reachability, and config health.
npx @coderover/mcp@latest doctor
```

Other CLI subcommands: `install`, `uninstall`, `upgrade`, `doctor`. See
`packages/mcp/README.md` for the full command surface.

---

## 4. Watch daemon (optional)

Phase 10 C3 ships `coderover-watch` — a long-running filesystem watcher that
debounces events (500ms default) and honors `.gitignore` plus a built-in
ignore set (`.git/`, `node_modules/`, `dist/`, `build/`, `.next/`, `target/`,
`__pycache__/`).

```bash
# From coderover-api/
npm run watch:cli -- /path/to/your/repo --repo-id <repo-uuid>

# Or after build:
node dist/cli/watch.js /path/to/your/repo --repo-id <repo-uuid>

# Options:
#   --debounce-ms <n>     debounce window (default 500)
#   --verbose             forward debounce-level logs
#   --observe-only        run without hitting the ingest pipeline (default true)
```

**Shipped in observe-only mode.** The daemon debounces, counts, and emits
metrics today; wiring the full `IncrementalIngestService` processor is a
near-term follow-up (see [`ROADMAP.md`](./ROADMAP.md) — "In flight"). The
`--observe-only` default will flip once the processor lands.

SIGINT / SIGTERM drain the queue, print final stats, and close the Nest
context cleanly — safe to `Ctrl-C`.

---

## 5. Benchmarks (optional)

Phase 10 C5 ships two harnesses under `coderover-api/benchmarks/`:

```bash
cd coderover-api
npm run bench                 # both
npm run bench:reingest        # ContentCache hot-path hit rate
npm run bench:watch           # watch event → processed latency
```

Pass/fail thresholds, straight from `benchmarks/README.md`:

- `reingest_unchanged` fails if **hit rate < 99%** or **p95 > 100ms**.
- `watch_latency` fails if **p95 > 1000ms** (given a 500ms debounce).

Use these as regression gates — run them before and after any touch to
`src/cache/` or `src/ingest/`.

---

## Phase 10 add-ons

If you're on an existing Phase 9 install, Phase 10 brings these:

- Run migrations 020–023 (`npm run migration:run`).
- Restart the API once so the one-time `graph_migrations` Cypher runner tags
  legacy edges with `AMBIGUOUS`.
- No env var changes are required. (The MCP token flow reuses `JWT_SECRET`.)
- Install `@coderover/mcp` into whatever agent you use (see §3).
- Optional: bring up the watch daemon (see §4) and run the benchmarks (§5).

See [`CHANGELOG.md`](./CHANGELOG.md) for the full diff.

---

## Troubleshooting

- **Migration 015 fails with "null value in column org_id"** — means a Phase
  8-or-earlier row was left without an org attribution. The migration
  back-fills from `users.default_org_id`. If that's also null, create a
  default org via the admin UI first, or run the repair described in the
  Phase 9 runbook §11.
- **Memgraph not reachable (`bolt://localhost:7687` connection refused)** —
  the app degrades gracefully; graph-only features stop returning rows.
  `docker compose ps memgraph` to confirm it's up; `docker compose logs
  memgraph` if it's not.
- **OpenAI quota / 429s on ingest** — the ingestion pipeline retries with
  backoff. Use OpenRouter (`sk-or-...`) as a cheap fallback, or set
  `LLM_PROVIDER=local` and point `OPENAI_BASE_URL` at Ollama / LM Studio.
- **`/health` reports `llm.status: down`** — see `SETUP.md` §6 in the Phase 9
  section of the repo's prior doc (same fix still applies):
  set `LLM_HEALTH_CHECK_ENABLED=false` on dev boxes with no local LLM wired.
- **`401 Password is required` on `/auth/login`** — the 2026-04-15 security
  hotfix removed the legacy passwordless branch. Register an account first.
- **`npx @coderover/mcp install claude-code` writes nothing** — check
  `~/.config/claude-code/` exists and is writable. On macOS the path is
  `~/Library/Application Support/Claude/` for the desktop app.
- **MCP tool call returns `isError: true`** — token valid? scope set
  (`search:read` / `citations:read` / `graph:read`)? Backend version match?
  Walk through the runbook at
  [`docs/runbook-phase10.md`](./docs/runbook-phase10.md) §MCP.
- **Watch daemon stays silent on edits** — verify the path isn't in the
  default ignore set (`.gitignore`, `node_modules/`, `dist/`, ...). Pass
  `--verbose` to see debounce-level logs.

<!-- TODO: capture the exact macOS Claude Code config path once a design-partner tests it; flags above are from packages/mcp/src/installer/agents/claude-code.ts. -->
