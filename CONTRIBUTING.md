# Contributing to CodeRover

Thanks for your interest. CodeRover is an AI copilot for large codebases —
NestJS API, React frontend, MCP client package, VS Code extension — all in
this monorepo.

This doc covers how to propose a change. For first-run setup and the full
environment bring-up, read [`SETUP.md`](./SETUP.md) first.

## Before you start

- **Search existing issues / PRs.** Someone may already be on it.
- **Open an issue before a large PR.** For anything beyond a small fix,
  file an issue describing the problem and your proposed approach. We'd
  rather align early than rework a 500-line PR.
- **Small PRs land faster.** Scope a change tightly. One concern per PR.

## Development setup

```bash
git clone https://github.com/MUST-Company-AX-Booster/coderover.git
cd coderover
cp coderover-api/.env.example coderover-api/.env
docker compose -f coderover-api/docker-compose.yml up -d
```

Full prerequisites, env vars, and the Phase 10 add-ons (MCP, watch daemon,
benchmarks) are documented in [`SETUP.md`](./SETUP.md).

## Branch + commit conventions

- **Branch off `main`.** Use short, prefixed names:
  `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`.
- **Conventional-commit prefixes** for commit subjects:
  `feat(api): ...`, `fix(frontend): ...`, `chore(mcp): ...`, `docs: ...`,
  `test: ...`, `refactor(...): ...`. Scope in parentheses is the package
  (`api`, `frontend`, `mcp`, `landing`, `docs`, etc).
- **Subjects in imperative mood**, no trailing period, under 72 chars.
  Body explains _why_, not _what_.
- **Breaking changes** get a `!` after the type: `feat(mcp)!: ...` and
  a `BREAKING CHANGE:` footer describing the migration.

Example:

```
feat(api): scope-gated JWTs for MCP tokens

POST /auth/tokens now mints per-user, per-org, short-TTL tokens with a
`scope` claim and a `kind: "mcp"` tag. Revocation is backed by the
revoked_tokens table with a 30-second per-process cache.
```

## Pull request checklist

Before requesting review:

- [ ] Branch is rebased on current `main`.
- [ ] `npm run build` passes in every package you touched
      (`coderover-api/`, `coderover-frontend/`, `packages/mcp/`, etc.).
- [ ] `npm test` passes in the same packages.
- [ ] Lint is clean: `npm run lint` in the package, or the relevant
      workspace command.
- [ ] Docs updated where behavior changed (`README.md`, `SETUP.md`,
      `CHANGELOG.md`, or the runbook in `docs/`).
- [ ] No secrets, access tokens, or private URLs committed.
- [ ] Commit messages follow the conventional-commit format above.

## Design system changes

CodeRover has a locked visual design system. Before any UI change, read
[`DESIGN.md`](./DESIGN.md) and [`CLAUDE.md`](./CLAUDE.md) at the repo root.
Reviewers will reject PRs that introduce:

- Colors outside the bone/ink/graphite ramp or the two signal colors
  (`#9FE0B4`, `#E89D9D`)
- Fonts other than Inter, JetBrains Mono, or BOKEH (wordmark-only)
- Border-radius other than 0, 2px, 4px, or 9999px
- Decorative gradients, stock icons, or purple/blue accents
- Generic empty-state copy ("No data") — use the mission-control voice

The `/design-system` route renders every brand primitive as a living spec.

## Multi-tenancy invariants

CodeRover is multi-tenant. Tenant-scoped services must fail closed when
`currentOrgId()` returns `null` — never silently use a fallback. If you're
adding a new service that reads tenant data, copy the pattern from an
existing one (`ChatService`, `IngestService`, `PrReviewService`) and make
sure your tests cover the missing-org case.

## Security-sensitive changes

Anything touching auth, token handling, tenant isolation, or data
exfiltration paths gets extra scrutiny. Please:

1. Flag the PR with the `security` label.
2. Write a short threat-model paragraph in the PR description: what new
   attack surface this introduces and how it's mitigated.
3. Add a regression test that exercises the failure case.

If you're reporting a vulnerability (not proposing a fix), follow
[`SECURITY.md`](./SECURITY.md) instead — don't open a public issue.

## Review flow

- A maintainer will review within a few business days.
- Expect pushback on scope and on anything that touches shared
  infrastructure (auth, migrations, graph schema).
- Once approved, a maintainer will squash-and-merge. The PR title
  becomes the merge commit subject, so write it in
  conventional-commit form.

## License

By contributing, you agree that your contributions will be licensed under
the [Apache License 2.0](./LICENSE).
