/**
 * Migration 002 — vector index via sqlite-vec.
 *
 * Loads the `sqlite-vec` extension and creates the `code_chunks_vec`
 * virtual table. Default dim 1536 matches OpenAI `text-embedding-3-small`
 * (the default local-mode embedder; see plan §4.3). Callers who want a
 * different dimensionality — e.g. the opt-in `Xenova/all-MiniLM-L6-v2`
 * offline embedder, which is 384-dim — should construct the migration
 * with `makeSqliteVecMigration(384)` instead of using the default export.
 */

import type Database from 'better-sqlite3';
import type { Migration } from '../migrator';
import { loadSqliteVec, createVecTable } from '../sqlite-vec';

export function makeSqliteVecMigration(dim: number = 1536): Migration {
  return {
    id: '002_sqlite_vec',
    up(db: Database.Database): void {
      loadSqliteVec(db);
      createVecTable(db, dim);
    },
  };
}

export const migration002SqliteVec: Migration = makeSqliteVecMigration();
