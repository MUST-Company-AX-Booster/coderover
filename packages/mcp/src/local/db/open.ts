/**
 * Opens a better-sqlite3 database with the pragmas local-mode MCP relies on.
 *
 * Pragma choices:
 *   - `journal_mode = WAL`   — writer and readers don't block each other.
 *     Watch-mode ingest writes while MCP tools read; WAL makes this safe
 *     without global locking.
 *   - `synchronous = NORMAL` — fsync on WAL checkpoints only (not per-txn).
 *     WAL + NORMAL is the standard "fast + crash-safe enough" combo.
 *   - `foreign_keys = ON`    — SQLite ships with FK enforcement *off* by
 *     default. We want it on so `symbols.chunk_id` cascade semantics hold.
 */

import Database from 'better-sqlite3';

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  return db;
}
