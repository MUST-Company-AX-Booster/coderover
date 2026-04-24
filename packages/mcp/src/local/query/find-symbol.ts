/**
 * Phase 11 Wave 3 — L13: `find_symbol` query over SQLite.
 *
 * Synchronous — no embedder, no vec0. Pure row-level lookup over the
 * `symbols` table (+ join on `code_chunks` for the span columns). The
 * WHERE clause supports three match modes in priority order:
 *
 *   1. Exact name    — `s.name = 'bar'` finds `bar` as defined.
 *   2. Qualified pfx — `s.qualified LIKE 'Foo%'` finds `Foo.bar` when
 *                      the caller types the containing class name.
 *   3. Qualified sfx — `s.qualified LIKE '%.bar'` finds `Foo.bar` when
 *                      the caller types the method name (and an exact
 *                      match on `name` doesn't already cover it).
 *
 * Rank: exact-name matches sort first (via `(name = ?) DESC`), then
 * alphabetical on `qualified` so output is deterministic across runs.
 *
 * Shape contract: `node_id` is read straight from `symbols.node_id` —
 * never recomputed here — so the ID stays stable across ingest and
 * remains interchangeable with the backend (`deterministic-ids` is a
 * byte-for-byte contract, see `src/local/deterministic-ids.ts`).
 */

import type Database from 'better-sqlite3';
import type { FindSymbolResponse, FindSymbolResult } from './types';

/** Default cap on results. Mirrors remote-mode default UX. */
const DEFAULT_LIMIT = 10;

export interface FindSymbolOptions {
  db: Database.Database;
  /** Default {@link DEFAULT_LIMIT}. */
  limit?: number;
}

/**
 * Internal row shape from the JOIN query. Keep in sync with the SELECT list.
 */
interface SymbolRow {
  node_id: string;
  name: string;
  qualified: string;
  kind: string;
  file_path: string;
  line_start: number;
  line_end: number;
}

/**
 * Look up a symbol by its short name or qualified name. Returns up to
 * `limit` hits. Returns an empty array (not throws) when no symbol
 * matches — the MCP tool response should still be a well-formed
 * `{ totalFound: 0 }` payload.
 */
export function findSymbol(
  symbolName: string,
  opts: FindSymbolOptions,
): FindSymbolResponse {
  const limit = opts.limit ?? DEFAULT_LIMIT;

  // The `OR` chain matches:
  //   - exact short name (most common case)
  //   - qualified prefix  — `qualified LIKE 'Foo%'` catches `Foo.bar`
  //   - qualified suffix  — `qualified LIKE '%.bar'` catches `Foo.bar`
  //                         when only the member name is given
  //
  // Prefix uses `LIKE ? || '%'` rather than `LIKE '<val>%'` so the
  // parameter can't inject a `%` wildcard — bound values are treated
  // verbatim by SQLite.
  //
  // ORDER BY puts exact-name matches first; alphabetical on `qualified`
  // so the output is deterministic (ties in the DB's physical order
  // would leak through to the response otherwise).
  const sql = `
    SELECT s.node_id    AS node_id,
           s.name       AS name,
           s.qualified  AS qualified,
           s.kind       AS kind,
           c.file_path  AS file_path,
           c.line_start AS line_start,
           c.line_end   AS line_end
      FROM symbols s
      JOIN code_chunks c ON c.id = s.chunk_id
     WHERE s.name = ?
        OR s.qualified LIKE ? || '%'
        OR s.qualified LIKE '%.' || ?
     ORDER BY (s.name = ?) DESC, s.qualified ASC
     LIMIT ?
  `;

  const rows = opts.db
    .prepare(sql)
    .all(symbolName, symbolName, symbolName, symbolName, limit) as SymbolRow[];

  const results: FindSymbolResult[] = rows.map((r) => ({
    filePath: r.file_path,
    lineStart: r.line_start,
    lineEnd: r.line_end,
    node_id: r.node_id,
    confidence: 'EXTRACTED',
    confidence_score: 1.0,
  }));

  return {
    symbolName,
    results,
    totalFound: results.length,
  };
}
