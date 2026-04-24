<!--
Before opening:

- Read CONTRIBUTING.md.
- For large or cross-cutting changes, open an issue first and link it here.
- Keep the PR focused — one concern per PR.
-->

## What

<!-- What does this PR change, in one or two sentences? -->

## Why

<!-- What problem does it solve? Link the issue if there is one: `Closes #123`. -->

## How

<!-- Key implementation decisions, tradeoffs, anything reviewers should
know to read the diff in the right order. -->

## Surface area

- [ ] API (new endpoints, migrations, or behavior changes)
- [ ] Frontend (routes, pages, brand components)
- [ ] MCP package / installer
- [ ] VS Code extension
- [ ] Landing page
- [ ] Docs only
- [ ] CI / build / tooling

## Checks

- [ ] Branch rebased on current `main`.
- [ ] `npm run build` passes in every package I touched.
- [ ] `npm test` passes in every package I touched.
- [ ] `npm run lint` is clean.
- [ ] Docs updated where behavior changed (`README.md`, `SETUP.md`, `CHANGELOG.md`, or the runbook in `docs/`).
- [ ] No secrets, tokens, or private URLs committed.
- [ ] Commit messages follow the conventional-commit format (`feat(api): ...`).

## Security notes

<!--
If this change touches auth, token handling, tenant isolation, or data
exfiltration paths:

- What new attack surface does this introduce?
- How is it mitigated?
- Is there a regression test for the failure case?

If not applicable, write "N/A".
-->

## Screenshots or recordings

<!-- For visual changes, attach before/after. For CLI changes, paste
a terminal recording. Delete this section if not applicable. -->
