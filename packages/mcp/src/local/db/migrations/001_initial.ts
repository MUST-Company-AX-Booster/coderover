/**
 * Migration 001 — initial non-vector schema.
 *
 * Creates `code_chunks`, `symbols`, `imports`, `file_hashes` and their
 * indexes. See `../schema.ts` for the statement list.
 */

import type Database from 'better-sqlite3';
import type { Migration } from '../migrator';
import { INITIAL_SCHEMA_STATEMENTS } from '../schema';

export const migration001Initial: Migration = {
  id: '001_initial',
  up(db: Database.Database): void {
    for (const stmt of INITIAL_SCHEMA_STATEMENTS) {
      db.prepare(stmt).run();
    }
  },
};
