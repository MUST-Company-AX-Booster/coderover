# Security Policy

## Reporting a vulnerability

**Please do not file security issues in public GitHub issues.**

If you believe you've found a security vulnerability in CodeRover — in the
API, the frontend, the MCP package, the VS Code extension, or anywhere
else in this repository — report it privately through a **GitHub private
security advisory**:

https://github.com/MUST-Company-AX-Booster/coderover/security/advisories/new

This routes the report directly to the maintainer team, keeps the
discussion private until a fix ships, and lets us coordinate a CVE if the
issue warrants one. Please do not file security issues as public GitHub
issues, and do not post them in discussions.

If you cannot use the advisory form for any reason, open a minimal
public issue titled "Security contact request" without describing the
vulnerability, and a maintainer will reach out privately.

Include in your advisory, where you can:

- A clear description of the issue and its impact.
- Steps to reproduce (PoC code, curl commands, repo state).
- Affected versions / commits.
- Any mitigation you've already identified.
- A contact channel we can reply on if the advisory thread isn't enough.

We'll acknowledge receipt within **3 business days** and aim to provide
a fix or mitigation plan within **14 days** for high-severity issues.
We'll credit you in the advisory and in `CHANGELOG.md` once the fix
ships, unless you prefer to stay anonymous.

## Scope

In scope:

- `coderover-api/` — REST API, workers, migrations, authentication
- `coderover-frontend/` — React SPA and public landing page
- `packages/mcp/` and `packages/mcp-offline/` — MCP client packages
- `coderover-api/vscode-extension/` — VS Code extension
- Infrastructure configuration in `docker-compose.yml`, deploy docs

Out of scope:

- Third-party services CodeRover integrates with (report to them directly).
- Vulnerabilities in unmodified third-party dependencies — please still
  tell us so we can pin a patched version, but the disclosure goes to
  the upstream maintainer first.
- Social engineering, physical attacks, or denial-of-service against
  CodeRover's hosted instances.

## Supported versions

CodeRover is pre-1.0 and under active development. We currently support
security fixes on the latest `main` branch and the most recent tagged
release. Older releases are not patched.

| Version | Supported |
| ------- | --------- |
| `main`  | Yes       |
| Latest tag (see `VERSION`) | Yes |
| Older   | No        |

## Safe harbor

We will not pursue legal action against researchers who:

- Act in good faith and follow this policy.
- Do not access, modify, or delete user data beyond what's strictly
  necessary to demonstrate the issue.
- Give us a reasonable window to fix the issue before public disclosure
  (we target 90 days; let's talk if you think we need more or less).

Thanks for helping keep CodeRover and its users safe.
