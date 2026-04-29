'use strict';
/**
 * @coderover/mcp-typescript
 * ──────────────────────────────────────────────────────────────────────────
 * Companion package for @coderover/mcp that wires in the real
 * `tree-sitter-typescript` grammar so local-mode indexing parses TS
 * source faithfully — including type annotations, interfaces, type
 * aliases, generics, decorators, and the JSX/TSX dialects.
 *
 *   npm install @coderover/mcp-typescript
 *
 * After install, `@coderover/mcp` automatically prefers this grammar
 * for `.ts` / `.tsx` / `.mts` / `.cts` files. No env var, no flag —
 * the loader probes for `tree-sitter-typescript` on the resolution
 * path and falls back to `tree-sitter-javascript` only when this
 * companion isn't installed.
 *
 * Why a separate package: `tree-sitter-typescript` is ~38 MB unpacked
 * (a precompiled native parser plus the grammar artifacts for both
 * the `typescript` and `tsx` dialects). Forcing every install to pay
 * that cost would undo the install-bloat win 0.3.0 got from splitting
 * out `@coderover/mcp-offline`. Pure-JS users, remote-mode users, and
 * Python/Go/Java-only users never need this; only the TS-heavy
 * codebases do.
 *
 * The module exports nothing runtime-callable; the resolution side
 * effect is the point. We export a version string so integration
 * tests and `coderover doctor` checks can detect presence.
 */

module.exports = {
  version: require('./package.json').version,
};
