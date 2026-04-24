/**
 * Thin seam over `sqlite-vec` so the rest of the local-mode code doesn't
 * import the extension directly. Keeping this thin means:
 *
 *   1. We can swap the vector backend (e.g. to sqlite-vss or a bespoke
 *      FAISS binding) without touching the ingest / query paths.
 *   2. Tests can mock `loadSqliteVec` and `createVecTable` to exercise the
 *      non-vec code paths on environments where the native binary isn't
 *      available (CI sandboxes, platforms we haven't built for yet).
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

/**
 * Loads the `sqlite-vec` extension into the given database connection.
 * Must be called before any DDL or DML that references `vec0` virtual
 * tables or `vec_f32()` / `vec_distance_*()` helpers.
 */
export function loadSqliteVec(db: Database.Database): void {
  sqliteVec.load(db);
}

/**
 * Creates the `code_chunks_vec` virtual table used for KNN lookups.
 *
 * @param db   An open database with `sqlite-vec` already loaded.
 * @param dim  Embedding dimensionality. Default 1536 matches OpenAI
 *             `text-embedding-3-small`, which is the default embedder for
 *             local mode (plan §4.3).
 */
export function createVecTable(db: Database.Database, dim: number = 1536): void {
  const ddl = `CREATE VIRTUAL TABLE IF NOT EXISTS code_chunks_vec USING vec0(
      chunk_id TEXT PRIMARY KEY,
      embedding float[${dim}]
    );`;
  db.prepare(ddl).run();
}
