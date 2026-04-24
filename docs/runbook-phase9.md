# CodeRover Phase 9 — Operational Runbook

Companion to `CodeRover_Phase9_Plan.docx`. Covers the operational steps required to promote Phase 9 features from the built/merged state into production.

## 1. Migrations

Phase 9 adds four migrations:

| # | Name | Effect |
|---|------|--------|
| 011 | `Organizations1713000000011` | Creates `organizations`, `org_memberships`, adds nullable `org_id` to 7 tenant tables, seeds Default org + every existing user as owner |
| 012 | `TokenUsage1713000000012` | Adds `token_usage_periods`, `installed_plugins` |
| 013 | `BackfillMemberships1713000000013` | Idempotent re-run of membership backfill (safe on fresh schemas) |
| 014 | `OrgIdNotNull1713000000014` | Backfills stragglers, sets `org_id NOT NULL` on 7 tenant tables |

### Production rollout

1. **Backup.** `pg_dump --schema-only` + `pg_dump --data-only` before starting.
2. **Rehearse 011 on a prod snapshot.** Particular attention to row count on `repos`, `agent_runs`, `chat_sessions`, `pr_reviews`. Expected: one UPDATE scan per table with default org ID written.
3. **Run in maintenance window.** Migrations 011–014 apply in a few seconds on tables with <1M rows; longer for agent_runs/chat_sessions if multi-million-row.
4. **Verify.** After 014 completes:
   ```sql
   SELECT table_name, column_name, is_nullable
   FROM information_schema.columns
   WHERE column_name = 'org_id';
   ```
   All 7 tenant rows should show `is_nullable = NO`.
5. **Rollback.** Each migration has a `down()` that is idempotent and safe to run.

## 2. Feature flags

Phase 9 code is in the main branch but several capabilities depend on environment:

| Flag | What it gates |
|------|---------------|
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | GitHub App check_run lifecycle in PR flow. Without these, PR reviews still run but no check_run is created. |
| `OTEL_ENABLED` (default on) | Set to `false` to disable the OpenTelemetry SDK init entirely (e.g., in tests). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Where traces go. Defaults to `http://localhost:4318/v1/traces`. |
| `OTEL_SERVICE_NAME` | `coderover-api` by default; used as Prometheus `service` label too. |
| `organizations.monthly_token_cap` (DB column) | Per-org AI spend cap. NULL = unlimited. Set via OrgsPage or `POST /organizations/:orgId/cap`. |

## 3. GitHub App setup

Required to enable `check_run` status updates and authenticated PR comments posting.

1. **Create a new GitHub App.** Settings → Developer settings → GitHub Apps → New.
   - Permissions: `pull_requests:write`, `checks:write`, `contents:read`, `metadata:read`.
   - Subscribe to events: `pull_request`.
   - Webhook URL: `https://your-host/webhooks/github`.
   - Webhook secret: any strong random string — set `GITHUB_WEBHOOK_SECRET` to match.
2. **Generate a private key.** Download the PEM.
3. **Store credentials.**
   ```
   GITHUB_APP_ID=123456
   GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
   ```
   In prod use a secrets manager; the env vars above are read by `GitHubAppService`.
4. **Install on target orgs/repos.** The webhook payload will include `installation.id`; pass it to `PrReviewService.reviewPullRequest({installationId})` from the webhook handler.
5. **Rotate key.** Generate a new PEM, update secret, revoke the old one. `installationTokenCache` expires naturally.

## 4. OpenTelemetry collector

The API emits OTLP/HTTP traces. Any compatible collector works; the usual options:

- **Local dev:** `otel-collector` with stdout exporter — just run the container on `:4317`/`:4318` and point `OTEL_EXPORTER_OTLP_ENDPOINT` at it.
- **Prod:** Point `OTEL_EXPORTER_OTLP_ENDPOINT` at Honeycomb / Grafana Tempo / Datadog / Jaeger endpoint. Default sampling is 100% — add env-configured `OTEL_TRACES_SAMPLER=parentbased_traceidratio` + `OTEL_TRACES_SAMPLER_ARG=0.1` for 10% in prod.

Verify traces via the `copilot.retrieval` and `copilot.generation` spans after making a /copilot/chat request.

## 5. Prometheus scraping

`/metrics` returns prom-text on port 3001. Typical scrape config:

```yaml
scrape_configs:
  - job_name: coderover-api
    scrape_interval: 30s
    static_configs:
      - targets: ['coderover-api:3001']
```

Relevant metrics:

- `coderover_ai_tokens_total{org,kind}` — cumulative tokens per org per kind (prompt/completion)
- `coderover_ingest_duration_seconds{repo,size_bucket}` — histogram, `small` <100, `medium` 100–1000, `large` ≥1000 files
- `coderover_agent_runs_active`, `coderover_agent_runs_queued` — gauges
- Default Node process metrics — `process_cpu_seconds_total`, heap, gc, event loop lag

⚠️ Org ID is used as a label. If the environment has thousands of orgs, consider dropping the label (or mapping to slug) at the collector to keep cardinality bounded.

## 6. VS Code extension distribution

The extension scaffold lives at `coderover-api/vscode-extension/`. To publish:

1. Install `vsce`: `npm i -g @vscode/vsce`.
2. `cd coderover-api/vscode-extension && vsce package` → produces `coderover-*.vsix`.
3. For internal distribution: share the VSIX; users run `code --install-extension coderover-*.vsix`.
4. For Marketplace: create a publisher, `vsce login <publisher>`, `vsce publish`.

The extension has four commands: `CodeRover: Set API Token`, `Search Codebase`, `Chat`, `Review Current PR`. Token is stored in VS Code's SecretStorage.

## 7. Token caps — operational guidance

`organizations.monthly_token_cap` is in total tokens (prompt + completion summed). Typical values:

| Org tier | Cap |
|----------|-----|
| Trial | 1,000,000 |
| Team | 10,000,000 |
| Enterprise | NULL (unlimited, monitor via `coderover_ai_tokens_total`) |

When a cap is breached, AI calls on copilot + agent-refactor paths throw `ForbiddenException`. The UI shows a toast; users can bump the cap on `/orgs` (owner/admin only).

## 8. Monitoring / alerting suggestions

- **Cap approaching:** alert when `sum by (org) (coderover_ai_tokens_total) / cap > 0.8`.
- **Ingest p95 latency:** alert when `histogram_quantile(0.95, rate(coderover_ingest_duration_seconds_bucket[5m])) > 300` (5 min).
- **Agent queue growing:** alert when `coderover_agent_runs_queued > 20` for more than 10 min.
- **WebSocket connections dropping:** alert on rate of socket.io errors (auto-instrumented via OTel).

## 9. Known limitations

- **Swift tree-sitter grammar:** no stable npm package; Swift files are detected and chunked via regex boundaries but lack AST-level symbol extraction.
- **Plugin sandbox:** `node:vm`-based. Adequate for trusted first-party plugins only; use `isolated-vm` / `workerd` for untrusted third-party plugins.
- **Check_run:** requires App credentials. Without them, PR reviews are functional but do not create a GitHub check.
- **Multi-tenant data migration:** 011–014 were rehearsed on local dev data; prod requires a data-volume rehearsal with row counts from real workload.

## 10. Rollback plan

If Phase 9 behavior needs to be rolled back:

1. Revert app to the pre-Phase-9 build (`git checkout <pre-phase-9-commit>`, redeploy).
2. Keep migrations 011–014 applied — they are additive and backward compatible (old code simply ignores the `org_id` columns).
3. If truly reverting DB: run the migrations in reverse (`npm run migration:revert` four times).

## 11. Developer pitfalls

Short list of gotchas that have bitten us during Phase 9 development. Worth reviewing before making structural changes.

### 11.1 Adding a new entity requires registration in THREE places

`DatabaseModule` (`src/database/database.module.ts`) registers TypeORM's DataSource with an **explicit** entities array, not a glob. Adding a new entity file is not enough — you must:

1. **Create the entity file** under `src/entities/` (or a feature folder).
2. **Register it with the DataSource** by importing the class and adding it to the `entities: [...]` array in `DatabaseModule`. Without this, `Repository<Entity>.find()` throws `EntityMetadataNotFoundError: No metadata for "<Name>" was found` at runtime — even though the module compiles and the service's `@InjectRepository(Entity)` resolves.
3. **Register it on the module that uses it** via `TypeOrmModule.forFeature([Entity])` so Nest can inject the repository.

If you only do #1 and #3, the build passes, the container boots, and the error surfaces only on the first request that hits `.find()`. The commit `ed69b40` is a worked example of this bug — `Organization` and `OrgMembership` were added to two forFeature calls but forgotten in `DatabaseModule`.

Quick check: after adding an entity, search for its class name:

```bash
grep -r "class MyNewEntity" coderover-api/src
```

Every result must be accounted for: the definition, the DatabaseModule array, and any forFeature imports.

### 11.2 Migration order does not depend on the numeric prefix alone

TypeORM picks migrations by the **class name's trailing timestamp**, not the filename prefix. Our convention is to keep both in sync (`011_organizations.ts` → `Organizations1713000000011`), but if you ever fork the number, the apply order will follow the class suffix. Always keep the filename prefix and class timestamp monotonically increasing together.

### 11.3 `currentOrgId()` returns `undefined` in worker (Bull) contexts

The `OrgScopeInterceptor` populates AsyncLocalStorage at the HTTP request boundary. Bull job consumers do not pass through that interceptor — so `currentOrgId()` inside a processor returns `undefined`, and any `where: { orgId }` filter will collapse to unscoped. Two acceptable patterns:

- **Explicit:** embed `orgId` in the job payload; the processor reads it and calls `runWithOrg({ orgId, userId, role }, async () => ...)` from `src/organizations/org-context.ts` to re-enter scope.
- **Implicit:** do not rely on scoping inside workers; trust that the enqueuing request already persisted rows with the correct `orgId`.

Review commit `54a98f1` for the `IngestService` precedent — event emissions include `repoId`, and the downstream worker uses that directly rather than recomputing scope.

### 11.4 JWT payload changes are not backward compatible

Adding a field to `JwtPayload` (like `orgId`) is safe — old tokens simply omit it. But removing or renaming a field breaks every already-issued token until the user signs in again. Plan such changes behind a feature flag and expect a session-invalidation wave.

### 11.5 OTel must initialize before NestFactory.create

`src/observability/tracer.ts` is imported at the **top of `main.ts`** — before any other import that could transitively load `http`, `express`, `pg`, `ioredis`. If you reorder imports so that anything non-trivial loads first, auto-instrumentations silently stop patching those modules. Trace data continues to flow for anything patched later, but HTTP spans can disappear. Keep the tracer import at the top.

### 11.6 Token cap guard on NEW AI call sites

When adding a new OpenAI / Anthropic call site (for a new agent, a new tool, etc.), remember to:

1. Inject `TokenCapService` (`import { TokenCapService } from '../observability/token-cap.service'` and add to module's `imports: [ObservabilityModule]`).
2. Call `await this.tokenCap.guard(orgId)` **before** the API call.
3. Call `await this.tokenCap.recordUsage(orgId, promptTokens, completionTokens)` **after** the response.

Otherwise the new path silently bypasses the per-org monthly cap.

## 12. Security hotfix timeline (2026-04-15)

Two High-severity vulnerabilities were found and patched on `main` as commit
`f283164`. Details:

**Vuln 1 — auth bypass + cross-tenant leakage (confidence 10).**
`POST /auth/login` had a legacy branch that issued an Admin JWT with no
`orgId` claim when the body omitted `password`. The token then bypassed
`OrgScopeInterceptor` (silent no-op on missing orgId) and tenant services fell
back to unscoped reads — unauthenticated admin with cross-tenant read.
- `AuthController.login` now requires `dto.password` → 401 otherwise.
- Tenant services now fail closed on missing org scope with
  `ForbiddenException('Organization scope required')`:
  `RepoService.findAll`, `SessionService.getUserSessions`,
  `AgentService.listRuns`, `PrReviewService.listReviews`.

**Vuln 2 — invite privilege escalation (confidence 9).**
A plain MEMBER could call `POST /organizations/:orgId/members` with
`{role: 'owner'}` and grant OWNER to an accomplice.
- `OrganizationsController.invite` now uses `@Param('orgId')` as the
  authoritative target, requires caller is `OWNER` or `ADMIN`, and enforces
  role hierarchy (only OWNER may grant OWNER).

**Verification:**
- `curl -X POST /auth/login -d '{"email":"x@y"}'` → HTTP 401
  `{"message":"Password is required"}`.
- Invite without OWNER/ADMIN membership → HTTP 403
  `"Only owners and admins may invite members"`.
- MEMBER attempting to grant OWNER with ADMIN caller → HTTP 403
  `"Only an owner may grant the owner role"`.

**Operator action required:** any existing tokens issued by the legacy path
carry no `orgId` claim and will now be rejected by tenant endpoints. Force a
re-login for all users after deploy, or rotate the JWT signing secret so old
tokens fail signature verification.

