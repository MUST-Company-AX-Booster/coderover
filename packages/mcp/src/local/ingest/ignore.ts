/**
 * Phase 11 Wave 2 — L5: gitignore-style matcher for local-mode ingest.
 *
 * Thin wrapper over the `ignore` npm package. The walker needs directory
 * patterns, negation, and leading-slash anchoring — all of which git
 * implements in non-trivial ways. The reference implementation is the
 * backend's `coderover-api/src/ingest/watch-ignore.ts` (Phase 10 C3); we
 * intentionally copy the pattern here instead of cross-depending so the
 * MCP package stays installable without the backend.
 *
 * Pattern sources, applied in order:
 *   1. `DEFAULT_IGNORE_PATTERNS` — baked-in ignores for repo noise we
 *      never want to index (`.git/`, `node_modules/`, build outputs,
 *      test-runner artifacts).
 *   2. Root `.gitignore` — honoured as written, including negations.
 *      Nested `.gitignore` files are out of scope; repos that rely on
 *      them can pass the patterns via `additionalIgnore`.
 *   3. Caller's `additionalIgnore` — CLI / config user-supplied globs.
 *
 * Note: the local-mode default set adds `.coderover/` (the SQLite DB dir
 * for local mode) instead of `.coderover-cache/` (backend daemon cache).
 */

import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ignore = require('ignore');

export type IgnoreMatcher = (relPath: string) => boolean;

/**
 * Default ignore patterns for the local-mode walker. Applied before any
 * `.gitignore` rules so callers can negate them with `!pattern` in
 * `.gitignore` if they really mean it.
 *
 * `dir/` and `dir` both work with the `ignore` pkg: `dir/` is strict
 * "directory only", `dir` matches file-or-directory. Using `dir/` here
 * means a top-level FILE literally named `dist` (rare, but seen in some
 * build setups) is not falsely excluded. Documented by `ignore@5.x`.
 */
export const DEFAULT_IGNORE_PATTERNS: string[] = [
  '.git/',
  'node_modules/',
  'dist/',
  'build/',
  '.next/',
  'target/',
  '__pycache__/',
  '.coderover/',
  'coverage/',
];

/**
 * Read the root `.gitignore` if present. Returns an empty array on I/O
 * failure so a missing `.gitignore` does not break the walker.
 */
export function readRootGitignore(rootPath: string): string[] {
  const gitignorePath = path.join(rootPath, '.gitignore');
  try {
    return fs.readFileSync(gitignorePath, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}

/**
 * Build the complete ignore matcher for a repo root:
 *
 *   defaults  ⊕  root/.gitignore  ⊕  caller's additionalIgnore
 *
 * The returned predicate accepts a forward-slash relative path (never a
 * leading `/`) and returns `true` if the path should be ignored. Paths
 * that are empty or escape the root with `..` always return `false` — the
 * matcher refuses to answer for things outside its scope instead of
 * guessing. This matches `coderover-api/src/ingest/watch-ignore.ts`.
 */
export function buildIgnoreMatcher(
  rootPath: string,
  additionalIgnore: string[] = [],
): IgnoreMatcher {
  const ig = ignore();
  ig.add(DEFAULT_IGNORE_PATTERNS);
  const gitignoreLines = readRootGitignore(rootPath);
  if (gitignoreLines.length > 0) ig.add(gitignoreLines);
  if (additionalIgnore.length > 0) ig.add(additionalIgnore);

  return (relPath: string): boolean => {
    if (!relPath || relPath.startsWith('..')) return false;
    return ig.ignores(relPath);
  };
}
