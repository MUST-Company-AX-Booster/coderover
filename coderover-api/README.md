# CodeRover API

AI-native service that turns source code into a searchable knowledge base, then exposes it through:

- A RAG + tool-using chat endpoint (SSE streaming)
- A Model Context Protocol (MCP) server for IDE integrations (Trae/Cursor/Continue)

Phase 7 adds Graph Intelligence: dependency graph visualization, circular dependency detection, impact analysis, and architectural hotspot detection.

## Phase 7 Specs (Graph Intelligence)

- **Dependency Graph**: Builds a directed graph of modules and imports from indexed code chunks.
- **Cycle Detection**: Identifies circular dependencies (e.g., A -> B -> C -> A) to prevent runtime issues.
- **Impact Analysis**: Traces reverse dependencies to show which files are affected by a change in a specific module.
- **Hotspot Detection**: Ranks modules by in-degree to identify architectural bottlenecks (most imported files).
- **New Endpoints**:
  - `GET /graph/dependencies`: Full dependency tree.
  - `GET /graph/cycles`: List of circular dependency chains.
  - `GET /graph/impact`: Downstream impact of a file change.
  - `GET /graph/hotspots`: Top most-used modules.
- **New MCP Tool**: `graph_analysis` for AI agents to reason about codebase structure.

## Phase 6 Specs

- **Multi-language ingestion**: detects language + framework per file/repo and stores it on chunks.
- **Hybrid search**: combines semantic similarity and BM25 full-text rank in one query (0.7 semantic, 0.3 BM25).
- **Context artifacts**: indexes non-source files (OpenAPI, schemas, Terraform, GraphQL, protobuf, docs) into a separate table and searches them with BM25.
- **Developer CLI**: `npx coderover init` and `npx coderover generate-env` generate validated `.env` with framework auto-detection.
- **Swagger UI**: OpenAPI docs at `/api-docs`.
- **Health dashboard**: runtime checks and metrics at `/health`.
- **MCP server (JSON-RPC 2.0)**:
  - Streamable HTTP: `POST /mcp`
  - SSE transport: `GET /mcp` + `POST /mcp/message?sessionId=...`
  - Methods: `initialize`, `tools/list`, `tools/call`, `ping`

## Tech Stack

- **Runtime**: Node.js 20
- **Framework**: NestJS 10 (TypeScript)
- **DB**: PostgreSQL 16 + pgvector
- **ORM**: TypeORM 0.3
- **Queue**: Bull (Redis)
- **LLM SDK**: OpenAI SDK (supports OpenAI, OpenRouter, and local OpenAI-compatible base URLs)
- **Parsing**: tree-sitter (multi-language)
- **GitHub**: Octokit (REST)

## Architecture

1. **Ingest** pulls files from GitHub (full or incremental) or from a local watcher session.
2. **Chunk** splits source files into chunks with metadata (module name, line ranges, symbols/imports, language, framework).
3. **Embed** generates embeddings for chunks and upserts to Postgres (pgvector).
4. **Index** creates/maintains BM25 indexes (tsvector triggers) for hybrid search.
5. **Serve**:
   - `/copilot/chat` uses RAG (search → context) and an agentic tool loop via MCP tools.
   - `/mcp` exposes tools for IDEs and function-calling models.

## Data Model (Postgres)

- `repos`: registered repositories (owner/name, branch, token override, detected language/framework).
- `code_chunks`: chunked source + embeddings + tsvector BM25 + structural metadata.
- `sync_logs`: last indexed commit SHA and stats per repo.
- `chat_sessions`, `chat_messages`: persisted copilot conversations.
- `context_artifacts`: indexed non-source context (schemas/OpenAPI/Terraform/docs) + BM25.
- `pr_reviews`, `webhook_events`: PR review automation and webhook audit log.

## Environment Variables

Required (validated at startup):

- `PORT` (default `3001`)
- `DATABASE_HOST`
- `DATABASE_PORT` (note: docker-compose maps Postgres to `5434`)
- `DATABASE_NAME`
- `DATABASE_USER`
- `DATABASE_PASSWORD`
- `REDIS_HOST` (default `localhost`)
- `REDIS_PORT` (note: docker-compose maps Redis to `6380`)
- `OPENAI_API_KEY`
- `GITHUB_TOKEN`
- `JWT_SECRET` (min 32 chars)

Optional:

- `LLM_PROVIDER` (`auto|openai|openrouter|local`, default `auto`)
- `OPENAI_BASE_URL` (for OpenRouter or local OpenAI-compatible servers)
- `OPENAI_CHAT_MODEL`
- `OPENAI_EMBEDDING_MODEL`
- `OPENAI_EMBEDDING_DIMENSIONS` (default `1536`, auto-validated against DB vector size)
- `GITHUB_WEBHOOK_SECRET` (enables GitHub webhook signature verification)
- `ANTHROPIC_API_KEY` (legacy; PR review still uses the OpenAI SDK)
- `DEFAULT_REPO`, `DEFAULT_BRANCH` (used by `/ingest/*` endpoints when no repo is provided)
- `FILE_WATCH_ENABLED` (`true|false`, enables local live re-indexing)

## Onboarding (Local Dev)

### 1) Start infrastructure

```bash
docker-compose up -d
```

This starts:

- Postgres: `localhost:5434` (container `5432`)
- Redis: `localhost:6380` (container `6379`)

### 2) Configure environment

```bash
cp .env.example .env
```

Set at minimum: `DATABASE_*`, `REDIS_*`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `JWT_SECRET`.

Or run the interactive wizard:

```bash
npx coderover init
```

### 3) Install dependencies

```bash
npm install
```

### 4) Run migrations

```bash
npm run migration:run
```

### 5) Start the API

```bash
npm run start:dev
```

Server default: `http://localhost:3001`

Health: `http://localhost:3001/health`  
Swagger: `http://localhost:3001/api-docs`

## Authentication (JWT)

Only `/auth/login` is public. Everything else requires `Authorization: Bearer <token>`.

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@example.com","password":"yourpassword"}' | jq -r '.accessToken')
```

## API Documentation

### Core Endpoints

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| GET | /health | No | Runtime status and system metrics |
| POST | /auth/login | No | Get JWT token |
| GET | /analytics/summary | Yes | Live stats across indexed data |
| POST | /copilot/chat | Yes | Chat with RAG + MCP tool loop (SSE streaming) |
| GET | /copilot/sessions | Yes | List chat sessions |
| GET | /copilot/sessions/:id/history | Yes | Session message history |

### Repo Registry

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| POST | /repos | Yes | Register a repo (stores token + branch + metadata) |
| GET | /repos | Yes | List active repos |
| GET | /repos/:id | Yes | Repo details |
| DELETE | /repos/:id | Yes | Deactivate repo |
| DELETE | /repos/:id/hard | Yes | Hard delete repo |
| POST | /repos/:id/ingest | Yes | Queue ingest for registered repo |
| GET | /repos/:id/status | Yes | Sync status for registered repo |

### Ingestion

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| POST | /ingest/trigger | Yes | Queue ingest (Bull) |
| POST | /ingest/trigger-sync | Yes | Run ingest synchronously |
| GET | /ingest/status?repo=owner/name | Yes | Sync status by repo full name |
| GET | /ingest/stats | Yes | Knowledge base stats |
| GET | /ingest/github-test?repo=owner/name&branch=main | Yes | Validate GitHub token + file listing |

### Context Artifacts (Phase 5)

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| GET | /artifacts/search?q=...&repoId=...&type=... | Yes | Search artifacts (BM25) |
| GET | /artifacts/list?repoId=...&type=... | Yes | List artifacts for a repo |
| GET | /artifacts/stats?repoId=... | Yes | Artifact counts by type |

### MCP (Phase 5)

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| POST | /mcp | Yes | Streamable HTTP JSON-RPC (single or batch) |
| GET | /mcp | Yes | SSE stream (server pushes responses) |
| POST | /mcp/message?sessionId=... | Yes | Send JSON-RPC requests for SSE transport |
| POST | /mcp/execute | Yes | Convenience wrapper to execute a tool by name |

### PR Review + Webhooks

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| POST | /webhooks/github | No | GitHub webhook receiver (signature verified if configured) |
| POST | /pr-review/trigger | Yes | Manually trigger PR review |
| GET | /pr-review/list?limit=20 | Yes | List recent PR reviews |
| GET | /pr-review/:owner/:repoName/:prNumber | Yes | Fetch a specific PR review |
| GET | /webhooks/events?limit=50 | Yes | List recent webhook events |

### Local File Watcher (Optional)

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| POST | /watcher/start | Yes | Start watching a local directory (requires `FILE_WATCH_ENABLED=true`) |
| DELETE | /watcher/stop/:repoId | Yes | Stop watching |
| GET | /watcher/sessions | Yes | List active watcher sessions |

## MCP Tools (Phase 5)

Tools exposed via `tools/list` and `tools/call`:

- `search_codebase`: hybrid search across `code_chunks` (+ optional artifact search)
- `get_module_summary`: summarize all chunks for a module name
- `get_api_endpoints`: extract REST endpoints from controller chunks (best-effort)
- `find_symbol`: locate a symbol definition (uses AST-enriched metadata)
- `find_dependencies`: find files importing a given path/module
- `generate_code`: retrieves relevant code patterns for code generation
- `review_pull_request`: run an AI PR review (optionally post a GitHub comment)

Example (Streamable HTTP):

```bash
curl -s -X POST http://localhost:3001/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_codebase","arguments":{"query":"where is JwtAuthGuard used?","topK":5}}}'
```

## Common Flows (Use Cases)

### 1) First-time indexing for a repo

```bash
curl -s -X POST http://localhost:3001/ingest/trigger-sync \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo":"owner/repo","branch":"main","forceReindex":true}'
```

### 2) Register repo → ingest → chat with scoped context

```bash
REPO_ID=$(curl -s -X POST http://localhost:3001/repos \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repoUrl":"https://github.com/owner/repo","branch":"main","githubToken":"<token>","label":"My Repo"}' | jq -r '.id')

curl -s -X POST http://localhost:3001/repos/$REPO_ID/ingest \
  -H "Authorization: Bearer $TOKEN"

curl -N -X POST http://localhost:3001/copilot/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"Explain the auth flow\",\"repoId\":\"$REPO_ID\"}"
```

### 3) Search schemas / OpenAPI / Terraform context (artifacts)

```bash
curl -s "http://localhost:3001/artifacts/search?repoId=$REPO_ID&q=refund%20policy&type=markdown" \
  -H "Authorization: Bearer $TOKEN"
```

### 4) IDE integration via MCP

- Use the MCP server at `http://localhost:3001/mcp`
- Authenticate with the same JWT used for the REST API
- Prefer Streamable HTTP (`POST /mcp`); fall back to SSE (`GET /mcp`)

### 5) Automated PR review

- Configure a GitHub webhook pointing to `POST /webhooks/github`
- On `pull_request` opened/synchronize/reopened: triggers AI review and can post a PR comment
- On `push` to default branch: queues incremental ingest

## Testing

```bash
npm run test
npm run test:e2e
npm run test:cov
```

## Troubleshooting

- **Database connection refused**: ensure Docker is running and `docker-compose up -d` is active. Postgres should be reachable at `localhost:5434`.
- **Redis connection refused**: ensure Redis is reachable at `localhost:6380` (or update `REDIS_PORT`).
- **Migrations failing**: verify `DATABASE_*` values match docker-compose and rerun `npm run migration:run`.
- **Webhook signature errors**: ensure `GITHUB_WEBHOOK_SECRET` matches the secret configured on GitHub and raw body capture is enabled (it is, in `main.ts`).
