# CodeRover — Roadmap

Where CodeRover is today, and where it's going. For a technical bring-up, see
[`SETUP.md`](./SETUP.md). For the landed diff per release, see
[`CHANGELOG.md`](./CHANGELOG.md).

Current `VERSION` file: see [`VERSION`](./VERSION). Current cut: **0.12.0**.

---

## Shipped (Phase 12 — April 2026) · Mission Control Brutalism

Phase 12 theme: **brand**. Translate the `coderover_web` concept into a
production design system across the frontend, ship the public landing page,
and pin the tokens in docs so future work can't drift. Six waves on a single
branch. No functional changes.

### Wave 1 — Brand tokens + fonts
BOKEH self-hosted display font (wordmark-only, `font-display: block`),
Google Fonts preconnect for Inter + JetBrains Mono, CSS variables remapped
to the bone/ink/graphite ramp + muted green/coral signals, default `:root`
flipped to dark, global CRT scanline overlay.

### Wave 2 — Brand primitives
Nine components under `coderover-frontend/src/components/brand/`:
`<Wordmark>`, `<Eyebrow>`, `<Kicker>`, `<Terminal>` + `<TerminalLine>` +
`<TerminalToken>`, `<CLIInstallBlock>`, `<RoverBadge>`, `<ProofRow>`,
`<CompareTable>`, `<AgentStatusLine>`. 16 tests. Public `/design-system`
route renders every primitive as a living spec.

### Wave 3 — Static landing page
`coderover-frontend/public/landing/` ships the 998-line HTML landing page,
grayscale brand-film video (webm 2.2 MB + mp4 6.7 MB), BOKEH fonts, and
`robots.txt`. OG + Twitter meta + canonical set to
`coderover.must.company`. Deploy contract in `docs/deploy/landing-nginx.md`.

### Wave 4 — Identity page reskins
`Layout` / `LoginPage` / `RegisterPage` / `DashboardPage` / `PrReviewsPage`
get `<Wordmark>` / `<Kicker>` / `<Eyebrow>` branding and mission-control
voice. Dashboard ships a Fleet Strip rendering all five rovers via
`<RoverBadge>`.

### Wave 5 — Terminal + demo surfaces
Chat is now a terminal (`$ <user>` / `[archive] <markdown>` lines with a
mono `§ sources` block). Search results read as `[beacon]` dispatches with
mono `file:line` citations. Graph gets an "Orbital Map" headline plus
React Flow theme overrides (void canvas, graphite nodes, silver edges,
accent-green hover).

### Wave 4b — Deep row reskin + remaining 9 pages
PR Reviews finding rows rebuilt as `[scout] BLOCK src/auth.ts:42 · security`
terminal lines. Dashboard stat cards drop colored icon tiles for mono
labels + tabular-nums numbers. Every remaining page (Analytics / Health /
Operations / Artifacts / Repos / RepoDetail / Settings / Orgs /
AgentDashboard) gets an `<Eyebrow prefix>` + two-clause headline.

### Wave 6 — Docs + handover
`DESIGN.md` + `CLAUDE.md` land at repo root; decisions log captures the 14
non-obvious calls made across Waves 1–5-4b. `CHANGELOG.md` [0.12.0] entry.
`README.md` "Brand system" section. `VERSION` 0.11.0 → 0.12.0.

---

## Shipped (Phase 11 — April 2026) · A3b Local Mode

`@coderover/mcp@0.2.0` on npm. Embedded, offline SQLite + sqlite-vec +
tree-sitter pipeline so agents can run against a local repo without any
backend. Offline MiniLM embedder (`CODEROVER_EMBED_MODE=offline`), watch
daemon, 8-check doctor. Python / Go / Java grammars alongside JS/TS.

---

## Shipped (Phase 10 — April 2026)

Phase 10 theme: **distribution + trust**. Make the features we already have
reachable from any MCP-capable agent, expose confidence + provenance on every
citation and graph edge, and cut the re-ingest cost on unchanged repos to
near zero.

### Workstream A — MCP distribution

- **A1 + A2 — `@coderover/mcp` greenfield.** Standalone Node package under
  `packages/mcp/`. MCP protocol handshake, JSON-RPC server, stdio transport,
  and an HTTP remote transport that proxies to a self-hosted CodeRover API.
  Capability gate via `GET /mcp/capabilities` so the client fails fast
  against an out-of-date backend.
- **A3 — installer CLI.** `npx @coderover/mcp install <agent>` writes an
  atomic config update for Claude Code, Cursor, Aider, Codex, and Gemini
  CLI. Other subcommands: `uninstall`, `upgrade`, `doctor`. Agent adapters
  live under `packages/mcp/src/installer/agents/`.
- **A4 — scope-gated JWTs + token revocation.** `POST /auth/tokens` mints
  per-user, per-org, short-TTL MCP tokens with a `scope` claim
  (`search:read` / `citations:read` / `graph:read`) and a `kind: "mcp"` tag.
  Revocation is backed by the `revoked_tokens` table with a 30-second
  per-process cache; the guard is a single PK lookup on `jti`.
- **A5 — integration test harness.** `packages/mcp-integration/` runs
  twenty-four end-to-end scenarios that import the real MCP client
  transport and drive a targeted NestJS test backend (in-memory TypeORM +
  recording Memgraph mock). No Postgres / Redis / Memgraph required to
  run the suite.

### Workstream B — Confidence + trust

- **B1 — Phase 10 SQL schema (migration 020).** `confidence_tag` Postgres
  enum (`EXTRACTED | INFERRED | AMBIGUOUS`), plus dedicated tables for the
  data that previously lived in JSONB blobs: `rag_citations`,
  `pr_review_findings`, `edge_producer_audit`, and `graph_migrations`.
  Backfill lives in migration 021 and defaults legacy rows to `AMBIGUOUS`.
- **B2 — `ConfidenceTagger` wired.** Single service with a `tag(evidence)`
  entry point; all nine graph producer sites call it. Graph nodes + edges
  get deterministic IDs (`hash(path + kind + qualified_name)` /
  `hash(src + dst + kind)`), so renames preserve edges and deletes clean
  up orphans.
- **B3 — frontend `ConfidenceMark` + `GraphConfidenceLegend`.** Shared
  component under `coderover-frontend/src/components/`, used on the Chat,
  PR Reviews, and Graph pages. Solid / half / hollow glyph vocabulary
  (color is supplementary) — passes WCAG AA and is legible in grayscale.
- **B4 — batch evidence endpoint.** `POST /citations/evidence` returns the
  evidence trail (file, line span, upstream producer) for a batch of
  citation IDs. Powers the "why?" inline accordion on the chat surface
  without N round-trips.

### Workstream C — Incremental ingest + cache + watch

- **C1 — `ContentCacheService`.** SHA256 content-addressed file cache.
  Blob stores behind a pluggable interface (LocalFs + S3). Redis-resident
  hash index loaded once at ingest-run start. Eviction runs LRU over
  `cache_entries.last_accessed_at` with a 90-day TTL backstop.
- **C2 — `IncrementalIngestService`.** Hash-diff input, skip unchanged
  files, apply deltas with deterministic node/edge IDs on the Memgraph
  MERGE. Renamed files preserve edges via `qualified_name` identity;
  deleted files clean up their nodes.
- **C3 — `WatchDaemonService`.** Long-running daemon driven by
  `@parcel/watcher`. 500ms debounce per path, honors `.gitignore`, bakes
  in an ignore set for `node_modules/`, `dist/`, `build/`, `.next/`,
  `target/`, `__pycache__/`, `.git/`. Ships in observe-only mode — see
  below for the processor wiring.
- **C3 CLI — `coderover-watch`.** npm bin entry at
  `coderover-api/dist/cli/watch.js`. SIGINT/SIGTERM drains the queue,
  prints final stats, and closes the Nest context. Invoked via
  `npm run watch:cli --` during development.
- **C4 — `TokenCapService` BudgetGuard.** Token-bucket implementation of
  the daemon's `BudgetGuard` interface. When a tenant's rate exceeds
  budget the daemon emits `watch-paused` / `watch-resumed` structured
  logs and increments `coderover_watch_back_pressure_total`.
- **C5 — benchmarks.** `benchmarks/reingest-unchanged.bench.ts` and
  `benchmarks/watch-latency.bench.ts`. Pass/fail thresholds baked into the
  harness: reingest hit rate ≥ 99% and p95 ≤ 100ms; watch latency p95 ≤
  1000ms. See [`coderover-api/benchmarks/README.md`](./coderover-api/benchmarks/README.md).

### Workstream D — Glue

- Top-level docs rewritten against what landed (this file, `SETUP.md`,
  `CHANGELOG.md`, `docs/runbook-phase10.md`).
- GitHub OAuth endpoints on `GitHubIntegrationController` deprecated to
  `410 Gone` — the unified `/auth/github/*` flow is the single supported
  entry point. See [`CHANGELOG.md`](./CHANGELOG.md).

---

## In flight / near-term

Work that's planned or in active development but not landed as of
2026-04-17.

- **A3b — local mode for `@coderover/mcp`.** Embed tree-sitter + SQLite +
  `sqlite-vec` so the MCP server runs without a backend. Zero-config
  install path. **Target: Q3 2026.**
- **C3 processor wiring.** Promote `WatchDaemonService` from observe-only
  to real-time incremental ingest by assembling the
  chunker + embedder + graph pipeline into a `ProcessFn` and plugging it
  into `WatchOptions.processFnFactory`. The TODO is flagged at the top of
  [`coderover-api/src/cli/watch.ts`](./coderover-api/src/cli/watch.ts).
  **Target: next sprint.**
- **D5 — design-partner track.** Ship early-access `@coderover/mcp@next`
  to a small cohort of external developers. Weekly office hours. Ships
  before we hit the criterion of a useful answer in Claude Code ≤ 3
  minutes from cold install.

---

## Longer horizon

No commitment, no date. These are the bets we believe in but haven't
scoped:

- [ ] Multi-repo graph linking. Cross-repo symbol resolution + org-level
      graph queries.
- [ ] Pluggable language backends. Scala, Swift, Elixir via the same
      tree-sitter + chunker contract that currently covers 16 languages.
- [ ] On-prem deploy + air-gapped mode. No telemetry egress, no external
      LLM requirement, signed release artifacts.
- [ ] Agent SDK (`@coderover/sdk`). First-party client for building custom
      agents on top of the CodeRover context + graph primitives.
- [ ] PR-review learning. Plain-English rules authored from accepted /
      rejected findings. (Phase 11 candidate.)
- [ ] Multimodal docs ingest. PDFs, diagrams, video transcripts tied to
      the graph. (Phase 12 candidate.)

---

## Historical phases

| Phase | Theme                               | Status    |
| ----- | ----------------------------------- | --------- |
| 1–6   | Ingest, embeddings, chat, agents, UI | Complete  |
| 7     | PR review agent                      | Complete  |
| 8     | Code graph RAG, ingest hardening     | Complete  |
| 9     | Platform + productization (multi-tenant, OTel, GitHub App) | Complete |
| 10    | Distribution + trust                 | Shipped 2026-04-17 |
| 11    | PR-review quality + learning loop    | Planned   |
| 12    | Multimodal + cross-repo graph        | Planned   |

No promises on the order or timing of 11 and 12.
