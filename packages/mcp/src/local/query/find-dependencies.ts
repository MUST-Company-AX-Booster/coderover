/**
 * Phase 11 Wave 3 — L14: `find_dependencies` query over SQLite.
 *
 * Synchronous. Two DISTINCT lookups against the `imports` table:
 *
 *   - DOWNSTREAM: "what does `target` import?"
 *       SELECT DISTINCT target_path FROM imports WHERE src_file = ?
 *
 *   - UPSTREAM: "who imports `target`?"
 *       SELECT DISTINCT src_file FROM imports WHERE target_path = ?
 *
 * `target` dispatch:
 *   - A repo-relative file path (`src/auth/auth.service.ts`) is matched
 *     verbatim — that's exactly how `imports.src_file` and
 *     `imports.target_path` are stored by the Wave 2 extractor.
 *   - A bare module name (e.g. `lodash`, `@nestjs/common`) is prefixed
 *     with `pkg:` for the upstream query. The Wave 2 resolver stores
 *     bare specifiers as `pkg:<name>` in `target_path` so they dedupe
 *     cleanly from in-repo files.
 *
 * We heuristically treat a `target` as "bare" when it has no path
 * separator and no file extension — that's tight enough to catch real
 * package names without swallowing unusual filenames. Scoped packages
 * (`@scope/name`) are also bare, and the `@` character is the tell.
 *
 * Dedup: both queries use `SELECT DISTINCT` so a file that imports the
 * same target twice (e.g. two `import {...} from 'lodash'` statements
 * in one file) collapses to one edge. The Wave 2 extractor already
 * dedupes during ingest, but belt-and-suspenders here is cheap and
 * guards against manual row inserts / future extractor changes.
 *
 * Confidence: always `EXTRACTED` / 1.0 — local mode's import edges are
 * AST-derived, no inference.
 */

import type Database from 'better-sqlite3';
import type {
  FindDependenciesEntry,
  FindDependenciesResponse,
} from './types';

export interface FindDependenciesOptions {
  db: Database.Database;
}

/**
 * Return all upstream (callers) and downstream (callees) edges for
 * `target`. Empty arrays when the target isn't known — never throws.
 */
export function findDependencies(
  target: string,
  opts: FindDependenciesOptions,
): FindDependenciesResponse {
  const upstreamKey = isBareModule(target) ? `pkg:${target}` : target;

  // Downstream: `src_file` stores repo-relative POSIX paths (or absolute
  // for out-of-repo files). Bare-module targets don't appear as
  // `src_file` values — a file can only IMPORT a package, not be one —
  // so we always use `target` verbatim for the downstream lookup.
  const downstreamRows = opts.db
    .prepare('SELECT DISTINCT target_path AS path FROM imports WHERE src_file = ? ORDER BY target_path ASC')
    .all(target) as Array<{ path: string }>;

  // Upstream: match against `target_path`. For bare-module targets we
  // match the `pkg:` key the Wave 2 resolver emits.
  const upstreamRows = opts.db
    .prepare('SELECT DISTINCT src_file AS path FROM imports WHERE target_path = ? ORDER BY src_file ASC')
    .all(upstreamKey) as Array<{ path: string }>;

  return {
    target,
    upstream: upstreamRows.map(toEntry),
    downstream: downstreamRows.map(toEntry),
  };
}

function toEntry(row: { path: string }): FindDependenciesEntry {
  return {
    filePath: row.path,
    confidence: 'EXTRACTED',
    confidence_score: 1.0,
  };
}

/**
 * True when `target` looks like a bare npm-style module specifier.
 *
 * Heuristic:
 *   - Starts with `@`       → scoped package (`@scope/name`).
 *   - No `/`, no `\`, and   → bare builtin / package (`lodash`, `fs`).
 *     no `.` in the basename  Basename check avoids false positives
 *                             on filenames like `foo.ts`.
 *
 * Anything else (contains a path separator, has a file extension,
 * starts with `.` / `/`) is treated as a path and matched verbatim.
 */
function isBareModule(target: string): boolean {
  if (target.startsWith('@')) return true;
  if (target.startsWith('.') || target.startsWith('/')) return false;
  if (target.includes('/') || target.includes('\\')) return false;
  // If it has a dot (e.g. `foo.ts`), treat as a file path. Bare packages
  // don't contain dots — package.json rejects dots in the top-level name.
  if (target.includes('.')) return false;
  return true;
}
