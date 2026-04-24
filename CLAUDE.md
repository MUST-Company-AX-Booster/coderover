# CLAUDE.md — CodeRover

## Design System

Always read `DESIGN.md` at the repo root before making any visual or UI decisions.
All font choices, colors, spacing, border-radius, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
When reviewing UI code, flag any component that doesn't match `DESIGN.md`:

- Any color not in the bone/ink/graphite ramp or the two signal colors (`#9FE0B4`, `#E89D9D`)
- Any font that is not Inter, JetBrains Mono, or BOKEH
- Any border-radius other than 0, 2px, 4px, or 9999px
- Any decorative gradient, blob, stock icon, or purple/blue accent
- Any empty-state copy that says "No data" instead of using the mission-control voice

## Brand voice

CodeRover speaks in 2am-terminal tone. Never marketing prose.
- Agent references use bracketed lowercase: `[scout]`, `[sentinel]`, never "Scout agent said..."
- Status words from the mission-control metaphor: `online`, `armed`, `patrolling`, `downlinked`, `landed`
- Section eyebrows prefix with `§` (e.g., `§ Features`)
- Banned words: "seamlessly", "robust", "delightful", "supercharge", "unleash", "game-changer"

## Repository layout

- `coderover-api/` — NestJS backend (Postgres + Redis + Memgraph + OpenTelemetry)
- `coderover-frontend/` — React + Vite + shadcn/ui + Tailwind. The "Mission Control" dashboard.
- `packages/mcp/` — `@coderover/mcp` npm package, local-mode MCP server
- `packages/mcp-integration/` — Integration tests for the MCP package
- `docs/` — Deploy runbooks, operator docs
