# CodeRover

AI copilot for large codebases. Indexes your repo into a code graph + vector
store, answers questions with citations, reviews pull requests, and plugs into
VS Code and GitHub.

Multi-tenant NestJS API + React frontend + VS Code extension, backed by
Postgres, Redis, and Memgraph.

> **Status: pre-1.0, active development.** APIs, database schema, and
> configuration are still evolving between releases. Pin a tagged version
> for anything production-adjacent. See [`ROADMAP.md`](./ROADMAP.md) for
> what's shipped and what's coming, and [`CHANGELOG.md`](./CHANGELOG.md)
> for migration notes between versions.

## Quickstart

```bash
git clone https://github.com/MUST-Company-AX-Booster/coderover.git
cd coderover
cp coderover-api/.env.example coderover-api/.env   # edit as needed
docker compose -f coderover-api/docker-compose.yml up -d
```

Then:
- Frontend: http://localhost:5173
- API: http://localhost:3001
- Health: http://localhost:3001/health
- Swagger: http://localhost:3001/api-docs *(open in dev; Basic-auth gated in prod)*

First-time setup, env vars, and the full bring-up path live in
[`SETUP.md`](./SETUP.md).

## What's in the repo

| Path | What it is |
|------|------------|
| `coderover-api/` | NestJS API, workers, migrations, Docker bring-up |
| `coderover-frontend/` | React + Vite app (Mission Control) |
| `coderover-frontend/public/landing/` | Static marketing landing page |
| `coderover-api/vscode-extension/` | VS Code extension source and VSIX |
| `packages/mcp/` | `@coderover/mcp` npm package (remote + local MCP server) |
| `docs/` | Deploy runbooks, operator docs |
| `DESIGN.md` | Design system — full token reference + brand voice |
| `CLAUDE.md` | Repo-level rules (read DESIGN.md before visual changes) |
| `SETUP.md` | First-run developer setup |
| `ROADMAP.md` | Current phase and upcoming work |
| `CHANGELOG.md` | Release history |

## Brand + design system

CodeRover ships a Mission Control Brutalism aesthetic across the frontend,
the public landing page, and the in-app mission-control voice. The full
token system, typography, palette, spacing, motion rules, and voice/microcopy
guide live at [`DESIGN.md`](./DESIGN.md).

Nine brand primitives live under
`coderover-frontend/src/components/brand/` — `<Wordmark>`, `<Eyebrow>`,
`<Kicker>`, `<Terminal>`, `<CLIInstallBlock>`, `<RoverBadge>`, `<ProofRow>`,
`<CompareTable>`, `<AgentStatusLine>`. The `/design-system` route (public,
no auth) renders every primitive as a living spec:
[http://localhost:5173/design-system](http://localhost:5173/design-system).

Before making any visual change, read `DESIGN.md`. Before adding a color
token outside the bone/ink/graphite ramp or one of the two signal colors
(`#9FE0B4`, `#E89D9D`), don't. See [`CLAUDE.md`](./CLAUDE.md) for the
full set of brand guardrails.

## For operators

Phase 9 operations (migrations, feature flags, GitHub App, OpenTelemetry,
Prometheus, token caps, known limits, rollback, developer pitfalls) are
documented in [`docs/runbook-phase9.md`](./docs/runbook-phase9.md). Phase 10
operations (MCP distribution, confidence tags, incremental ingest) are in
[`docs/runbook-phase10.md`](./docs/runbook-phase10.md).

## For contributors

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) before opening a PR. Short
version:

- Branch off `main`. Use `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, etc.
- One concern per PR. For large changes, open an issue first.
- `npm run build` and `npm test` must pass in every package you touch.
- Commit subjects follow conventional commits (`feat(api): ...`).
- Tenant-scoped services must fail closed when `currentOrgId()` is missing.

Community docs:

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — dev setup, branch + commit
  conventions, PR checklist.
- [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) — how we work together
  here.
- [`SECURITY.md`](./SECURITY.md) — private vulnerability disclosure.
  **Do not file security issues as public GitHub issues.**

## License

[Apache License 2.0](./LICENSE). See individual package manifests for
third-party license information.
