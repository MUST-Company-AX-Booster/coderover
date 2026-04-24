<!--
  Replace this comment with a hero screenshot (PNG/SVG).
  Recommended: 1200×630, dark background matching coderover.must.company.
  Suggested content: /design-system route with terminal chat + graph snippet.
-->

<h1 align="center">CodeRover</h1>

<p align="center">
  <strong>Graph-native AI copilot for large codebases.</strong><br/>
  Reviews pull requests, answers questions with cited evidence, and plugs into Claude Code, Cursor, Aider, Codex, and Gemini CLI via MCP.
</p>

<p align="center">
  <a href="https://github.com/MUST-Company-AX-Booster/coderover/actions/workflows/ci.yml"><img src="https://github.com/MUST-Company-AX-Booster/coderover/actions/workflows/ci.yml/badge.svg" alt="CI"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-blue.svg" alt="License"/></a>
  <a href="https://www.npmjs.com/package/@coderover/mcp"><img src="https://img.shields.io/npm/v/@coderover/mcp.svg?label=%40coderover%2Fmcp" alt="npm version"/></a>
  <a href="https://github.com/MUST-Company-AX-Booster/coderover/discussions"><img src="https://img.shields.io/github/discussions/MUST-Company-AX-Booster/coderover" alt="Discussions"/></a>
  <a href="https://coderover.must.company"><img src="https://img.shields.io/badge/landing-coderover.must.company-EDEBE5?labelColor=0A0A0A" alt="Landing page"/></a>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#features">Features</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#why-coderover">Why CodeRover</a> ·
  <a href="./SETUP.md">Docs</a> ·
  <a href="https://coderover.must.company">Website</a>
</p>

---

## What it does

- **Graph-aware search.** Understands imports, calls, and inheritance — not just tokens. Ask *"what calls `authenticate()`?"* and get a traversed answer with file-and-line evidence.
- **Autonomous PR review.** Runs on GitHub as a `check_run`. Blocks, warns, or approves based on graph-wide impact. Every finding carries a provenance trail.
- **MCP-native.** One `npx` command installs CodeRover into Claude Code, Cursor, Aider, Codex, or Gemini CLI. Remote or fully offline mode.

> **Status: pre-1.0, active development.** APIs, database schema, and configuration evolve between releases. Pin a tagged version for anything production-adjacent. See [`ROADMAP.md`](./ROADMAP.md) and [`CHANGELOG.md`](./CHANGELOG.md).

## Quickstart

### Use it from your AI assistant (MCP)

```bash
npx @coderover/mcp install claude-code
# Also supported: cursor, aider, codex, gemini-cli
```

The installer writes an atomic config update to your agent's MCP config file and walks you through getting a scoped token. Works against a remote CodeRover API or a fully local install via `@coderover/mcp-offline`.

### Self-host the whole stack (Docker)

```bash
git clone https://github.com/MUST-Company-AX-Booster/coderover.git
cd coderover
cp coderover-api/.env.example coderover-api/.env   # edit as needed
docker compose -f coderover-api/docker-compose.yml up -d
```

Then:

- Frontend (Mission Control): http://localhost:5173
- API: http://localhost:3001
- Health: http://localhost:3001/health
- Swagger: http://localhost:3001/api-docs *(dev only; Basic-auth gated in prod)*

Full bring-up, env vars, and first-repo ingest are in [`SETUP.md`](./SETUP.md).

## Features

- **Code graph.** Memgraph stores `File`, `Symbol`, `Class`, `Method`, `Function` nodes with `DEFINES`, `IMPORTS`, `CALLS`, `INHERITS`, `DEPENDS_ON` edges. Every edge tagged `EXTRACTED` / `INFERRED(score)` / `AMBIGUOUS` so you can tell truth from hallucination.
- **RAG with citations.** Every answer shows the exact `file:line_start-line_end` it came from. Confidence glyphs (solid / half / hollow) are legible in grayscale and pass WCAG AA.
- **PR review agent.** Integrates as a GitHub App `check_run`. Graph-wide impact analysis per finding. Plain-English rules learned from accepted/rejected reviews.
- **Incremental ingest.** Hash-diffed — re-ingests only changed files. Rename-aware (preserves edges via qualified-name identity). Watch daemon with `.gitignore` honoring + 500ms debounce.
- **MCP distribution.** `@coderover/mcp` installs into five agents via one `npx` command. Remote (HTTP proxy to self-hosted API) and local (embedded SQLite + sqlite-vec + tree-sitter) modes.
- **Multi-tenant.** Per-org scoping on every tenant table, scope-gated JWTs for MCP, monthly token caps per org. OpenTelemetry + Prometheus out of the box.
- **16 tree-sitter languages.** JS/TS, Python, Go, Rust, Java, Kotlin, PHP, Swift, Ruby, C, C++, C#, HTML, CSS, Bash, and more.
- **VS Code extension.** Chat + PR review inside the editor, with SSE streaming and SecretStorage-backed tokens.

## How it works

CodeRover indexes your repo into two backing stores working in concert:

1. **A code graph** in Memgraph. Tree-sitter extracts structural nodes (files, classes, methods, functions) and structural edges (defines, imports, calls, inherits, depends-on). Every edge carries a confidence tag — `EXTRACTED` for AST-derived, `INFERRED(score)` for LLM-derived, `AMBIGUOUS` when evidence is missing.
2. **A vector store** in pgvector. Code chunks get embeddings (OpenAI / OpenRouter / local Ollama / offline MiniLM). Search combines graph traversal with semantic similarity.

When an agent — the PR reviewer, the MCP tool surface, the in-app chat — answers a question, it walks both layers together. Every answer comes back with cited evidence (`file:line_start-line_end` pairs with confidence glyphs) so you can verify the LLM didn't hallucinate.

The **graph is the product.** Agents, MCP, search, and PR review are what you get when you have a graph to reason against.

## Why CodeRover

CodeRover doesn't replace your editor, your security scanner, or your code search — it's the graph-reasoning and human-approval layer those tools don't ship.

|                                     | Copilot / Cursor | Sourcegraph | Greptile | **CodeRover**     |
| ----------------------------------- | ---------------- | ----------- | -------- | ----------------- |
| Code graph with confidence tags     | —                | partial     | —        | ✓                 |
| Cycle / impact / hotspot queries    | —                | read-only   | —        | ✓                 |
| Autonomous PR review                | —                | —           | ✓        | ✓ *(graph-aware)* |
| Refactor proposals as PRs           | manual           | —           | —        | ✓                 |
| Team decision memory                | —                | —           | —        | ✓                 |
| MCP-native tool surface             | —                | —           | —        | ✓                 |
| Self-hosted                         | —                | enterprise  | —        | ✓                 |
| Open source (Apache 2.0)            | —                | —           | —        | ✓                 |

## Who this is for

- **Teams with 500k+ lines of code** where "grep" and "ask Cursor" stop working because the answer depends on structural relationships across modules.
- **Platform / infra engineers** who want graph-aware queries (cycles, impact radius, hotspots) that existing code search tools surface read-only or not at all.
- **Engineering leaders** who want PR review that blocks regressions based on impact, not just style.
- **Anyone using Claude Code / Cursor / Aider / Codex / Gemini CLI** who wants their agent to know the whole repo, not just the open files.

If you have a 10k-line monorepo, you probably don't need this — your editor's built-in features are enough.

## Documentation

- [`SETUP.md`](./SETUP.md) — full first-run setup, env vars, Phase 10 add-ons (MCP, watch daemon, benchmarks).
- [`ROADMAP.md`](./ROADMAP.md) — what shipped and what's planned.
- [`CHANGELOG.md`](./CHANGELOG.md) — release history with migration notes.
- [`docs/runbook-phase9.md`](./docs/runbook-phase9.md) — Phase 9 ops (OTel, Prometheus, GitHub App, token caps, rollback).
- [`docs/runbook-phase10.md`](./docs/runbook-phase10.md) — Phase 10 ops (MCP, confidence tags, incremental ingest, watch daemon).
- [`docs/deploy/RUNBOOK.md`](./docs/deploy/RUNBOOK.md) — production deploy runbook (nginx, Let's Encrypt, Contabo VPS).

## Contributing

PRs welcome. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first — it covers branch naming, conventional commits, the PR checklist, tenant-isolation invariants, and how to propose security-sensitive changes.

For visual changes, also read [`DESIGN.md`](./DESIGN.md) and [`CLAUDE.md`](./CLAUDE.md) at the repo root. CodeRover's design system is locked; unauthorized palette or font additions will be rejected in review.

## Community

- **Website:** [coderover.must.company](https://coderover.must.company)
- **Discussions:** [github.com/MUST-Company-AX-Booster/coderover/discussions](https://github.com/MUST-Company-AX-Booster/coderover/discussions) — usage questions, design discussions, "how do I...".
- **Issues:** [github.com/MUST-Company-AX-Booster/coderover/issues](https://github.com/MUST-Company-AX-Booster/coderover/issues) — bugs and feature requests.
- **Security:** [`SECURITY.md`](./SECURITY.md) — private vulnerability disclosure via GitHub security advisory.
- **Code of Conduct:** [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

If CodeRover saves you time, **a star helps us reach developers who need it.**

## License

[Apache License 2.0](./LICENSE) · Copyright 2026 MUST Company.

Third-party licenses live in each package's `package.json` and the transitive dependency tree — run `npm ls` or consult `package-lock.json` for the full list.
