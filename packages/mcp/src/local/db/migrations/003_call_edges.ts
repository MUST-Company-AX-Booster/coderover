/**
 * Migration 003 — `call_edges` table for symbol-grain `find_dependencies`.
 *
 * Pre-0.5.0 the only edges we stored were file→file `imports`, so
 * `find_dependencies("AuthService.verify")` returned `[]` even when
 * call sites existed. This migration adds a same-file call-site index:
 *
 *   - `caller_node_id` / `caller_qualified` — the enclosing function /
 *     method that contains the call expression.
 *   - `callee_name` — the simple identifier being called (e.g.
 *     `verify` for `svc.verify(token)`).
 *   - `callee_qualified` — best-effort dotted form (e.g.
 *     `AuthService.verify`) when the receiver disambiguates;
 *     `NULL` when only the bare name is known.
 *   - `src_file` + `call_line` — anchor for the call site.
 *   - `confidence` — `'EXTRACTED'` for AST-derived, no inference.
 *
 * What's deliberately NOT here:
 *   - Cross-file callee resolution. We don't try to walk imports +
 *     scope to prove `findUser` in `auth.ts` resolves to `db.ts::findUser`.
 *     The agent can chain `find_dependencies("AuthService.verify")` →
 *     `find_dependencies("path/to/file.ts")` if it wants the file edge.
 *     Cross-file symbol resolution lands in 0.6.x.
 *
 * Indexes are tuned for the two query shapes `find_dependencies` uses:
 *   - Match by callee qualified or bare name (upstream lookup).
 *   - Match by src_file (reingest delete-cascade).
 */

import type Database from 'better-sqlite3';
import type { Migration } from '../migrator';

export const CALL_EDGES_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS call_edges (
     edge_id           TEXT PRIMARY KEY,
     caller_node_id    TEXT NOT NULL,
     caller_qualified  TEXT NOT NULL,
     callee_name       TEXT NOT NULL,
     callee_qualified  TEXT,
     src_file          TEXT NOT NULL,
     call_line         INTEGER NOT NULL,
     confidence        TEXT NOT NULL DEFAULT 'EXTRACTED'
   )`,
  `CREATE INDEX IF NOT EXISTS idx_call_edges_callee_name
     ON call_edges(callee_name)`,
  `CREATE INDEX IF NOT EXISTS idx_call_edges_callee_qualified
     ON call_edges(callee_qualified)`,
  `CREATE INDEX IF NOT EXISTS idx_call_edges_src_file
     ON call_edges(src_file)`,
];

export const migration003CallEdges: Migration = {
  id: '003_call_edges',
  up(db: Database.Database): void {
    for (const stmt of CALL_EDGES_SCHEMA_STATEMENTS) {
      db.prepare(stmt).run();
    }
  },
};
