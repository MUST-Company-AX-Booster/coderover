/**
 * `find_dependencies` query — file-grain (0.1+) or symbol-grain (0.5+).
 *
 * Two query shapes share one tool. The MCP-facing argument is just
 * `target: string`; we dispatch on heuristic:
 *
 *   - File-grain (the original path): when `target` looks like a path
 *     (contains `/`, `\`, or `.<ext>`) we hit the `imports` table —
 *     the same SELECT DISTINCT shape as 0.4.x. Backwards compatible
 *     down to the byte level except for the new `targetKind: 'file'`
 *     marker on the envelope.
 *
 *   - Symbol-grain (new in 0.5.0): when `target` looks like a
 *     qualified symbol (`AuthService.verify`) or a bare identifier
 *     (`hashPassword`) we query `call_edges` for both directions:
 *       - upstream   = "who calls me?"     callee_qualified / name
 *       - downstream = "who do I call?"    caller_qualified
 *     Each edge surfaces the other endpoint's qualified name in the
 *     new optional `symbol` field plus the `line` of the call site.
 *
 *   - Bare module specifiers (`lodash`, `@scope/name`) keep the
 *     existing `pkg:`-prefix behaviour from 0.4.x — they're handled
 *     in the file-grain branch because they only appear as
 *     `imports.target_path`, never in `call_edges`.
 *
 * Heuristic order (target classification):
 *   1. Bare module → file-grain (`isBareModule`).
 *   2. Has path-shaped chars (`/`, `\`, or `.ext` extension) → file-grain.
 *   3. Otherwise → symbol-grain.
 *
 * Confidence: file-grain edges are always `EXTRACTED` / 1.0 (AST-derived
 * imports). Symbol-grain edges are `EXTRACTED` / 1.0 today because we
 * only emit AST-derived call edges; cross-file inferred edges land in
 * 0.6.x and will use `INFERRED` / 0.6.
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
 * Return all upstream (callers / importers) and downstream (callees /
 * imports) edges for `target`. Empty arrays when the target isn't
 * known — never throws.
 */
export function findDependencies(
  target: string,
  opts: FindDependenciesOptions,
): FindDependenciesResponse {
  const kind = classifyTarget(target);
  if (kind === 'symbol') {
    return findSymbolDependencies(target, opts);
  }
  return findFileDependencies(target, opts);
}

// ─── File-grain (file → imports table) ───────────────────────────────────

function findFileDependencies(
  target: string,
  opts: FindDependenciesOptions,
): FindDependenciesResponse {
  // Already `pkg:`-prefixed → use verbatim. Bare module spec → wrap.
  // Anything else → use verbatim (it's a path).
  const upstreamKey = target.startsWith('pkg:')
    ? target
    : isBareModule(target)
      ? `pkg:${target}`
      : target;

  // Downstream: `src_file` stores repo-relative POSIX paths (or absolute
  // for out-of-repo files). Bare-module targets don't appear as
  // `src_file` values — a file can only IMPORT a package, not be one —
  // so we always use `target` verbatim for the downstream lookup.
  const downstreamRows = opts.db
    .prepare(
      'SELECT DISTINCT target_path AS path FROM imports WHERE src_file = ? ORDER BY target_path ASC',
    )
    .all(target) as Array<{ path: string }>;

  // Upstream: match against `target_path`. For bare-module targets we
  // match the `pkg:` key the Wave 2 resolver emits.
  const upstreamRows = opts.db
    .prepare(
      'SELECT DISTINCT src_file AS path FROM imports WHERE target_path = ? ORDER BY src_file ASC',
    )
    .all(upstreamKey) as Array<{ path: string }>;

  return {
    target,
    upstream: upstreamRows.map(toFileEntry),
    downstream: downstreamRows.map(toFileEntry),
    targetKind: 'file',
  };
}

function toFileEntry(row: { path: string }): FindDependenciesEntry {
  return {
    filePath: row.path,
    confidence: 'EXTRACTED',
    confidence_score: 1.0,
  };
}

// ─── Symbol-grain (qualified or bare symbol → call_edges table) ──────────

function findSymbolDependencies(
  target: string,
  opts: FindDependenciesOptions,
): FindDependenciesResponse {
  // Upstream: "who calls me?" — match either qualified (e.g.
  // `AuthService.verify` matches `callee_qualified`) or bare name
  // (matches `callee_name`). We OR them so the caller can pass either
  // form and get hits.
  const upstreamRows = opts.db
    .prepare(
      `SELECT src_file AS path, caller_qualified AS symbol, call_line AS line, confidence
         FROM call_edges
        WHERE callee_qualified = ?
           OR callee_name = ?
        ORDER BY src_file ASC, call_line ASC`,
    )
    .all(target, simpleNameOf(target)) as Array<{
      path: string;
      symbol: string;
      line: number;
      confidence: string;
    }>;

  // Downstream: "who do I call?" — match the caller's qualified name.
  // We don't OR on bare name here because `caller_qualified` is the
  // *enclosing* function and is always known (no bare-only callers).
  const downstreamRows = opts.db
    .prepare(
      `SELECT src_file AS path, callee_qualified AS qualified, callee_name AS name,
              call_line AS line, confidence
         FROM call_edges
        WHERE caller_qualified = ?
        ORDER BY call_line ASC`,
    )
    .all(target) as Array<{
      path: string;
      qualified: string | null;
      name: string;
      line: number;
      confidence: string;
    }>;

  return {
    target,
    upstream: upstreamRows.map((r) => ({
      filePath: r.path,
      symbol: r.symbol,
      line: r.line,
      confidence: 'EXTRACTED',
      confidence_score: 1.0,
    })),
    downstream: downstreamRows.map((r) => ({
      filePath: r.path,
      symbol: r.qualified ?? r.name,
      line: r.line,
      confidence: 'EXTRACTED',
      confidence_score: 1.0,
    })),
    targetKind: 'symbol',
  };
}

/**
 * Decide whether `target` should hit the imports table (file) or the
 * call_edges table (symbol).
 *
 * Rules (first match wins):
 *
 *   1. Starts with `pkg:` or `@scope/name`  → file-grain (explicit
 *      module specifier — same semantics as 0.4.x).
 *   2. Contains `/` or `\`                  → file-grain (path).
 *   3. Last `.<seg>` is a known source ext  → file-grain (e.g.
 *      `src/auth.ts`, `Util.java`).
 *   4. Otherwise                            → symbol-grain.
 *
 * 0.5.0 BEHAVIOUR CHANGE (documented in CHANGELOG): a bare module
 * name like `lodash` previously routed to file-grain via an internal
 * `pkg:` rewrite. It now routes to symbol-grain and returns empty if
 * there are no call edges to a function literally named `lodash`. Pass
 * the explicit `pkg:lodash` form to recover the old behaviour. We made
 * this change because bare-name *symbol* lookups (`verify`,
 * `hashPassword`) are the more common B5 query and the unqualified
 * package case has the cleaner workaround.
 */
function classifyTarget(target: string): 'file' | 'symbol' {
  if (target.startsWith('pkg:')) return 'file';
  if (target.startsWith('@')) return 'file';
  if (target.startsWith('.') || target.startsWith('/')) return 'file';
  if (target.includes('/') || target.includes('\\')) return 'file';
  // Known source extensions force file-grain even for `Util.java`-style
  // dotted last segments.
  if (target.includes('.')) {
    const lastSeg = target.slice(target.lastIndexOf('.') + 1).toLowerCase();
    const KNOWN_EXTS = new Set([
      'ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs',
      'py', 'pyw', 'go', 'java', 'json', 'md', 'yml', 'yaml',
    ]);
    if (KNOWN_EXTS.has(lastSeg)) return 'file';
  }
  return 'symbol';
}

/**
 * True when `target` looks like a bare npm-style module specifier.
 * Same heuristic as 0.4.x — kept for backwards-compatible behaviour.
 */
function isBareModule(target: string): boolean {
  if (target.startsWith('@')) return true;
  if (target.startsWith('.') || target.startsWith('/')) return false;
  if (target.includes('/') || target.includes('\\')) return false;
  if (target.includes('.')) return false;
  return true;
}

/**
 * Strip the qualifier from `Foo.bar` → `bar` so the upstream lookup
 * also matches when the caller passed a qualified name but the call
 * was emitted bare (e.g. `verify(token)` inside `AuthService`).
 */
function simpleNameOf(target: string): string {
  const dot = target.lastIndexOf('.');
  return dot >= 0 ? target.slice(dot + 1) : target;
}
