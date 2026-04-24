# Changelog

All notable changes to CodeRover are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); dates are YYYY-MM-DD
(local). Versioning is loosely semver, anchored to Phase milestones until 1.0.

## [0.12.0] — 2026-04-20 — Phase 12: Mission Control Brutalism

Phase 12 ships the brand system across the frontend, the public landing page,
and the docs. Six waves on one branch. No functional changes; this is a visual
and voice transformation. Source of truth for the full token system lives at
[`DESIGN.md`](./DESIGN.md) at the repo root.

### Added

- **feat(design): `DESIGN.md` + `CLAUDE.md` at repo root.** Full token system,
  brand voice rules, component inventory, decisions log (14 entries covering
  every non-obvious call made across Waves 1–5-4b). `CLAUDE.md` pins the rule
  that any future visual change must read `DESIGN.md` first.
- **feat(frontend): brand primitives at
  `coderover-frontend/src/components/brand/` (Wave 2).** Nine components —
  `<Wordmark>`, `<Eyebrow>`, `<Kicker>`, `<Terminal>` + `<TerminalLine>` +
  `<TerminalToken>`, `<CLIInstallBlock>`, `<RoverBadge>`, `<ProofRow>`,
  `<CompareTable>`, `<AgentStatusLine>`. 16 tests covering the logic-bearing
  ones. Full type-exported barrel at `index.ts`.
- **feat(frontend): `/design-system` public route (Wave 2).** Visual spec
  rendering every primitive with real CodeRover content. Use it as the
  living spec for future design-review sessions.
- **feat(frontend): BOKEH self-hosted display font (Wave 1).** Wordmark-only,
  `font-display: block`. Loaded from `src/assets/fonts/`.
- **feat(frontend): Google Fonts preconnect for Inter + JetBrains Mono
  (Wave 1).** Declared in `index.html`. System-font override removed from
  `index.css`.
- **feat(frontend): CRT scanline overlay (Wave 1).** Global `body::before`
  layer, `mix-blend-mode: multiply`, `0.5` opacity in app / `1.0` on the
  marketing landing / disabled in light mode.
- **feat(landing): static landing page at
  `coderover-frontend/public/landing/` (Wave 3).** 33 KB HTML + 2.2 MB WebM +
  6.7 MB MP4 brand film + BOKEH fonts. Real CTAs (`/login`, GitHub repo,
  README anchor). OG + Twitter meta + `canonical` set to
  `coderover.must.company`. Deploy contract in
  [`docs/deploy/landing-nginx.md`](./docs/deploy/landing-nginx.md).
- **feat(frontend): `public/robots.txt` (Wave 3).** Allow landing indexing,
  disallow all SPA routes (which require auth anyway).
- **feat(frontend): Fleet Strip on DashboardPage (Wave 4).** Renders the
  five rovers as `<RoverBadge>` cards with status (online / armed /
  patrolling). Status data is hardcoded until the fleet-status API lands.
- **feat(frontend): React Flow theme overrides (Wave 5).** The Orbital Map
  renders in brand colors — void canvas, graphite nodes with bone mono 12px
  labels, silver edges, accent-green on hover/select.

### Changed

- **feat(frontend): replace shadcn primary/secondary/success/error palette
  with bone/ink/graphite ramp + two muted signal colors (Wave 1).** Primary
  is bone (`#EDEBE5`). Secondary is graphite (`#1A1A1A`). Accent is muted
  green `#9FE0B4`. Destructive is muted coral `#E89D9D`. Background is void
  `#0A0A0A`. Existing `--color-warning-*` and `--color-info-*` ramps are
  remapped (amber-coral and silver) rather than deleted, so 77 legacy usages
  across 9 pages keep working and degrade on-brand.
- **feat(frontend): default `:root` flipped to dark (Wave 1).** Brand is
  dark-first; `[data-theme="light"]` overrides with an inverted bone-on-
  paper ramp.
- **feat(frontend): Layout shell reskin (Wave 4).** Sidebar logo is now the
  `<Wordmark>` primitive (or "CR" when collapsed). Top-bar page title uses
  `<Eyebrow prefix>` in tracked mono ("§ DASHBOARD", "§ PR REVIEWS").
  Active nav highlight switches to `bg-foreground/[0.06]` + accent-green
  icon (the blue-on-blue primary-500/10 pattern would have rendered bone-on-
  bone under the new palette).
- **feat(frontend): identity pages reskin (Wave 4).** LoginPage +
  RegisterPage drop the purple gradient backdrop + Code2 icon for a
  `<Kicker>` + `<Wordmark>` + `<Eyebrow>` stack with mission-control voice.
  Cross-links use accent-green dotted-underline.
- **feat(frontend): Chat becomes a terminal (Wave 5).** Bubble thread
  replaced with `$ <user>` / `[archive] <markdown>` plain terminal lines in
  mono; sources under a mono `§ sources` block; typing indicator uses
  accent-green dots. Empty state: "Ask anything. The rover remembers."
- **feat(frontend): Search results read like beacon dispatches (Wave 5).**
  Each hit stamped `[beacon]` with `file:line` in mono; match% in accent-
  green tabular-nums; zero-results uses `<AgentStatusLine>`.
- **feat(frontend): PR Reviews finding rows (Wave 4b).** Rows render as
  `[scout] BLOCK src/auth.ts:42 · security  <message>` with the level token
  color-coded (destructive / warning / accent / muted) and everything else
  mono-silver. Filter pills become mono uppercase tracked chips.
- **feat(frontend): Dashboard stat cards (Wave 4b).** Drop the colored icon
  tiles. Cards now show mono uppercase labels + big tabular-nums values +
  muted top-right icon. Quick Actions use mission voice.
- **feat(frontend): 9-page voice pass (Wave 4b).** Every remaining page
  (Analytics / Health / Operations / Artifacts / Repos / RepoDetail /
  Settings / Orgs / AgentDashboard) gets an `<Eyebrow prefix>` +
  two-clause title. Health page's data-unavailable state switches to an
  `<AgentStatusLine level="block">`.
- **feat(frontend): Dashboard Fleet Strip wired to real `/health`.** The
  five `<RoverBadge>`s on the dashboard no longer render hardcoded
  "all online" theatrics. New `useFleetStatus` hook polls `/health`
  every 15s and derives each rover's status from real signals: queue +
  watcher sessions for `[scout]`, LLM component for `[tinker]` +
  `[sentinel]`, watcher + database for `[beacon]`, embedding coverage
  for `[archive]`. Notes show real numbers ("1,295 / 1,295 chunks
  indexed", "queue depth 0 · 0 sessions"). 10/10 hook tests green.
- **frontend/index.html title:** "My Trae Project" → "CodeRover · Mission
  Control".

### Deferred

- `og:image` — no social-card image yet; link previews render without.
  Create `public/landing/og-image.png` at 1200×630 and wire it up.
- Video compression of `cr_video.mp4` (6.7 MB) — webm at 2.2 MB is already
  well-compressed. Revisit with ffmpeg once available.
- Full deletion of `--color-warning-*` and `--color-info-*` scales — needs
  a sweep across the 9 pages that still reference them.
- Wiring the Dashboard Fleet Strip to a real fleet-status API (currently
  hardcoded).

## [Phase 10] — 2026-04-17 — Distribution + Trust

Phase 10 ships across fourteen workstreams under three goals: make
CodeRover's tool surface reachable from any MCP-compatible agent, expose
confidence + provenance on every citation and graph edge, and cut re-ingest
cost on unchanged repos. See [`ROADMAP.md`](./ROADMAP.md) for the
workstream-by-workstream breakdown.

### Added

#### Distribution (workstream A)

- **feat(mcp): `@coderover/mcp` greenfield — protocol + remote transport
  + stdio server (A1 + A2).** Standalone Node package under `packages/mcp/`
  exposing the CodeRover tool surface to any MCP-compatible agent. JSON-RPC
  server, stdio transport, and an HTTP remote transport that proxies to a
  self-hosted CodeRover API. Capability handshake via
  `GET /mcp/capabilities` lets the client fail fast on backend version skew.
- **feat(mcp): installer CLI for Claude Code, Cursor, Aider, Codex, and
  Gemini CLI (A3).** `npx @coderover/mcp install <agent>` writes an atomic
  config update; `uninstall`, `upgrade`, and `doctor` subcommands round out
  the lifecycle. Agent adapters under `packages/mcp/src/installer/agents/`.
- **feat(auth): scope-gated JWTs + token revocation (A4).**
  `POST /auth/tokens` mints per-user, per-org MCP tokens with a `scope`
  claim and `kind: "mcp"`. Revocation is a single PK lookup on the JWT's
  `jti`; see the Security section below for the token cache details.
- **test(mcp): integration harness with 24 end-to-end scenarios (A5).**
  `packages/mcp-integration/` exercises the real MCP client transport
  against a targeted NestJS test backend (in-memory TypeORM + recording
  Memgraph mock). Zero infra required to run the suite.

#### Trust (workstream B)

- **feat(db): Phase 10 SQL schema for confidence tags (B1, migration 020).**
  Adds the `confidence_tag` Postgres enum
  (`EXTRACTED | INFERRED | AMBIGUOUS`) and four new tables:
  `rag_citations`, `pr_review_findings`, `edge_producer_audit`, and
  `graph_migrations`.
- **feat(graph): `ConfidenceTagger` wired into 9 producer sites with
  deterministic node/edge IDs (B2).** All write paths now call
  `ConfidenceTagger.tag(evidence)` — no producer writes a raw tag. Graph
  node IDs = `hash(path + kind + qualified_name)`; edge IDs =
  `hash(src + dst + kind)`, so renames preserve edges and deletes clean up
  orphans.
- **feat(frontend): `ConfidenceMark` + `GraphConfidenceLegend` on Chat /
  PR Reviews / Graph (B3).** Shared geometric-glyph component (solid /
  half / hollow — color is supplementary). Passes WCAG AA and reads
  cleanly in grayscale.
- **feat(citations): `POST /citations/evidence` batch endpoint (B4).**
  Returns evidence trails (file, line span, surrounding context, upstream
  producer) for a batch of citation IDs. Backs the "why?" inline accordion
  without N round-trips.

#### Incremental + cache (workstream C)

- **feat(cache): `ContentCacheService` — SHA256 content-addressed file
  cache with LocalFs / S3 blob stores + Redis index + LRU eviction (C1).**
  Pluggable blob store interface (`src/cache/blob-store.ts`). Redis-resident
  hash index loaded at ingest-run start; eviction sweeps run LRU over
  `cache_entries.last_accessed_at` with a 90-day TTL backstop.
- **feat(ingest): `IncrementalIngestService` — hash-diff + delta apply
  (C2).** On re-run, skip unchanged files; apply graph deltas idempotently
  via deterministic IDs on the Memgraph MERGE.
- **feat(ingest): `WatchDaemonService` with `@parcel/watcher`, 500ms
  debounce, gitignore-aware (C3).** Observe-only today; the
  `IncrementalIngestService` processor wiring lands in a near-term
  follow-up. Default ignore set covers `.git/`, `node_modules/`, `dist/`,
  `build/`, `.next/`, `target/`, `__pycache__/` on top of `.gitignore`.
- **feat(cli): `coderover-watch` subcommand (C3 CLI).** User-facing shell
  around `WatchDaemonService`. SIGINT / SIGTERM drain the queue, print
  final stats, and close the Nest context. Invoked via
  `npm run watch:cli --` in dev.
- **feat(ingest): `TokenCapService` — token-bucket `BudgetGuard` (C4).**
  Reuses Phase 9 per-org cap machinery. When the daemon pauses,
  `watch-paused` / `watch-resumed` structured logs fire and
  `coderover_watch_back_pressure_total` increments.
- **bench: `reingest_unchanged` and `watch_latency` harnesses (C5).**
  Thresholds: reingest hit rate ≥ 99% and p95 ≤ 100ms; watch p95 ≤ 1000ms.
  See [`coderover-api/benchmarks/README.md`](./coderover-api/benchmarks/README.md).

#### Docs (workstream D)

- Top-level docs rewritten against what landed: `SETUP.md`, `ROADMAP.md`,
  `CHANGELOG.md` (this file), `docs/runbook-phase10.md`.

### Changed

Run these in order on an existing Phase 9 install. All four are additive.

- `020_phase10_confidence_schema` — creates the `confidence_tag` enum and
  the four new tables; legacy graph edges are tagged `AMBIGUOUS` by a
  one-time Cypher migration tracked in `graph_migrations`.
- `021_phase10_backfill_confidence_defaults` — unrolls existing
  `chat_messages.source_chunks` JSONB into `rag_citations` and
  `pr_reviews.findings.items` into `pr_review_findings`, defaulting
  `confidence = AMBIGUOUS`.
- `022_revoked_tokens` — creates the MCP token issuance + revocation table.
  Legacy tokens (no `jti`) bypass the table and remain valid on signature
  + exp.
- `023_cache_metadata` — creates `cache_entries` for the `ContentCache`
  LRU sweep.

Migrations 020 and 021 require a restart after `migration:run` so the
one-time `graph_migrations` Cypher runner can tag legacy Memgraph edges.
Migrations 022 and 023 are pure Postgres DDL and take effect immediately.

### Deprecated

- **`GitHubIntegrationController` OAuth endpoints** — `/github-integration/connect`
  and `/github-integration/callback` now return `HTTP 410 Gone` pointing
  at the unified `/auth/github/*` flow. `/github-integration/repos` and
  `/github-integration/webhooks/setup` remain; they operate on an
  already-authenticated user and do not initiate OAuth.

### Security

- **`RevokedToken` table + 30-second revocation cache.** The JWT guard
  does a single PK lookup on the token's `jti`; results are cached
  per-process for 30s to keep the hot path fast. Revoking in the admin
  UI invalidates across all API instances within the cache window.
- **Scope-gated JWTs.** MCP tokens carry a `scope` array claim
  (`citations:read`, `graph:read`, `search:read`) and a `kind: "mcp"`
  marker. `ScopeGuard` (see `src/auth/guards/scope.guard.ts`) enforces
  the required scope per controller route — see `@RequiresScope(...)` on
  `CitationsController`, `SearchController`, and the MCP tool
  controllers.
- Existing Phase 9 security hotfixes (auth bypass + cross-tenant leakage +
  invite privilege escalation) remain in place; Phase 10 does not touch
  those paths.

---

## [0.9.1] — 2026-04-15 — Phase 9 security hotfix + DX polish

### Security (HIGH)
- **Auth bypass + cross-tenant leakage (CVE-fix, f283164).** Removed the legacy
  passwordless login branch in `AuthController.login`. Without it, anyone could
  POST an email and get an Admin JWT with no `orgId` claim, then read any
  tenant's data. `/auth/login` now returns `HTTP 401 Password is required`
  when the password is missing.
- **Fail-closed tenant scoping (f283164).** `RepoService.findAll`,
  `SessionService.getUserSessions`, `AgentService.listRuns`, and
  `PrReviewService.listReviews` now throw `ForbiddenException('Organization
  scope required')` when `currentOrgId()` is undefined, instead of falling back
  to unscoped reads.
- **Invite privilege escalation (CVE-fix, f283164).**
  `POST /organizations/:orgId/members` now uses `@Param` as the authoritative
  org target, requires caller role `OWNER` or `ADMIN`, and enforces role
  hierarchy (only `OWNER` may grant `OWNER`).

### Developer experience
- `README.md` rewritten — quickstart, repo map, operator/contributor pointers.
  Previously 2 lines.
- Swagger UI (`/api-docs`) and the OpenAPI spec (`/api-docs-json`) are now
  unauthenticated in non-production. Production still gates them with Basic
  auth when `SWAGGER_USERNAME` / `SWAGGER_PASSWORD` are set.
- `LoginDto.password` is now required at the DTO level with a clear
  `password is required` validation message, instead of erroring through the
  runtime check only after email validation succeeds.
- `SETUP.md` step 6 updated to reflect password-required login.
- `docs/runbook-phase9.md` §12 added — security hotfix timeline,
  attack paths, verification curls, and the operator action to rotate
  `JWT_SECRET` or force re-login.

### For contributors
- This is the first CHANGELOG entry. Prior history lives in `git log`.
  `VERSION` file added at repo root.

## [0.9.0] — 2026-04-14 — Phase 9 code-complete (internal)

Phase 9 "Platform & Productization" landed across 6 workstreams. Captured
from `git log` as a single entry; future entries will follow per-change.

### Added
- WebSockets on `/events` namespace with JWT handshake; Socket.io primary,
  SSE fallback for ingest/agent status.
- GitHub App integration — App-JWT signing, installation tokens,
  `check_run` lifecycle gating PRs on PR review verdict.
- Multi-tenancy — `Organization` + `OrgMembership` entities, `org_id` on all
  7 tenant tables (migrations 011–014, `org_id NOT NULL` enforced),
  `OrgScopeInterceptor` + `AsyncLocalStorage` request context, org-switcher
  UI, admin memberships/caps page.
- Plugin sandbox (`node:vm`, first-party only; documented as not a security
  boundary) and multi-language chunk boundaries (Rust, Kotlin, Swift).
- VS Code extension — SecretStorage-backed API token, chat webview with SSE
  streaming, `reviewPr` command.
- Observability — OpenTelemetry SDK bootstrap pre-NestFactory, prom-client
  metrics (`coderover_agent_runs_active`, `coderover_agent_runs_queued`,
  ingest counters), token-cap service with monthly per-org cap enforcement.

### Fixed
- `EntityMetadataNotFoundError` on `GET /organizations` caused by
  `Organization` + `OrgMembership` missing from DatabaseModule's explicit
  entities array (ed69b40).

### Docs
- `docs/runbook-phase9.md` — operational runbook with §1–§11
  covering migrations, feature flags, GitHub App, OTel, Prometheus, VS Code
  distribution, token caps, monitoring, known limits, rollback, and
  developer pitfalls.
- `CodeRover_User_Guide.docx` — 15-section non-technical end-user guide.
- `CodeRover_Progress_Report.docx` v3 → v11.

## Earlier history

See `git log` for work prior to Phase 9. Notable milestones:

- Phase 8 — code graph RAG, ingest pipeline hardening.
- Phase 7 — PR review agent.
- Phases 1–6 — initial ingest, embeddings, chat, agents, UI foundation.
