import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ignore = require('ignore');

/**
 * Phase 10 C3 — gitignore-style matcher for the watch daemon.
 *
 * Thin wrapper over the battle-tested `ignore` npm package. The daemon
 * needs directory-pattern semantics, negation, and leading-slash
 * anchoring — all of which git implements in non-trivial ways. Rolling
 * our own regex compiler costs ~200 lines and still misses edge cases
 * (tested: `dist/` should also ignore `dist/main.js`, `/coverage` should
 * NOT match `nested/coverage`). `ignore` handles both correctly.
 *
 * We apply three pattern sources in order:
 *
 *   1. `DEFAULT_IGNORE_PATTERNS` — baked-in ignores for repo noise we
 *      never want to watch (`.git/`, `node_modules/`, build outputs,
 *      OS cruft).
 *   2. Root `.gitignore` — honored as written, including negations.
 *      Nested `.gitignore` files are explicitly out of scope.
 *   3. Caller's `additionalIgnore` — whatever the CLI / service
 *      user passes in, e.g. `--ignore "scripts/generated/**"`.
 */

export type IgnoreMatcher = (relPath: string) => boolean;

/**
 * Default ignore patterns for CodeRover watch. Applied in addition to
 * any `.gitignore` rules.
 */
export const DEFAULT_IGNORE_PATTERNS: string[] = [
  '.git/',
  'node_modules/',
  'dist/',
  'build/',
  '.next/',
  'target/',
  '__pycache__/',
  '.coderover-cache/',
  '.venv/',
  '.DS_Store',
];

/**
 * Read the root `.gitignore` if present. Returns an empty array on I/O
 * failure — the default set is still applied.
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
 * Build the complete ignore matcher for a repo root.
 *
 *   defaults  ⊕  root/.gitignore  ⊕  caller's additionalIgnore
 *
 * The returned function accepts a forward-slash relative path (never
 * a leading `/`) and returns `true` if the path should be ignored.
 * Paths that start with `..` or are `''` always return `false` so the
 * matcher can't accidentally swallow the root itself.
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
