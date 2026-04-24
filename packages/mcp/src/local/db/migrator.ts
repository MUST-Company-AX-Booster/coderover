/**
 * Minimal forward-only migration runner for the local-mode SQLite DB.
 *
 * Design goals:
 *   - Zero dependencies beyond `better-sqlite3`.
 *   - Idempotent: re-running `migrate()` on an already-migrated DB is a no-op.
 *   - Atomic per migration: each `up` runs inside a transaction so a failure
 *     leaves the DB in the previous clean state (no half-applied schema,
 *     no stale `_migrations` row).
 *   - Ordered: migrations run in the order the caller supplies. We do not
 *     sort by id — callers already know the correct order; sorting by id
 *     would silently "fix" a bad ordering and mask bugs.
 *
 * The ledger table is deliberately tiny: `(id TEXT PRIMARY KEY, applied_at
 * INTEGER)`. No checksum column — our migrations are TypeScript, not SQL
 * files on disk, so a checksum would only catch the case where someone
 * edits an already-applied migration (which is a code-review problem,
 * not a runtime problem).
 */

import type Database from 'better-sqlite3';

export interface Migration {
  /** Stable, human-readable id. Recorded in `_migrations`. */
  readonly id: string;
  /** Synchronous: better-sqlite3 is sync and transactions require it. */
  up(db: Database.Database): void;
}

const CREATE_LEDGER = `CREATE TABLE IF NOT EXISTS _migrations (
  id          TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL
)`;

/** Runs a DDL / DML script via better-sqlite3's batch runner. */
function runScript(db: Database.Database, sql: string): void {
  db.prepare(sql).run();
}

/**
 * Applies the given migrations in order. Each migration runs in its own
 * transaction; on throw, the transaction rolls back and the error is
 * re-raised with the failing migration id prepended.
 *
 * Returns the list of ids that were freshly applied this call (already-
 * applied migrations are skipped silently). The return value is useful
 * for boot-time logging ("applied 2 migrations").
 *
 * `async` on the signature lets callers `await migrate(...)` even though
 * better-sqlite3 is synchronous — future migration steps (e.g. downloading
 * a model file) may genuinely be async.
 */
export async function migrate(
  db: Database.Database,
  migrations: readonly Migration[],
): Promise<string[]> {
  assertUniqueIds(migrations);

  runScript(db, CREATE_LEDGER);

  const appliedRows = db
    .prepare('SELECT id FROM _migrations')
    .all() as Array<{ id: string }>;
  const applied = new Set<string>(appliedRows.map((r) => r.id));

  const newlyApplied: string[] = [];
  const insertLedger = db.prepare(
    'INSERT INTO _migrations (id, applied_at) VALUES (?, ?)',
  );

  for (const m of migrations) {
    if (applied.has(m.id)) continue;

    // better-sqlite3's `db.transaction()` wraps the function in BEGIN /
    // COMMIT / ROLLBACK automatically. A throw inside causes ROLLBACK
    // and rethrows — exactly what we want for atomicity.
    const run = db.transaction(() => {
      m.up(db);
      insertLedger.run(m.id, Date.now());
    });

    try {
      run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Migration "${m.id}" failed: ${msg}`);
    }

    newlyApplied.push(m.id);
  }

  return newlyApplied;
}

function assertUniqueIds(migrations: readonly Migration[]): void {
  const seen = new Set<string>();
  for (const m of migrations) {
    if (seen.has(m.id)) {
      throw new Error(`Duplicate migration id: "${m.id}"`);
    }
    seen.add(m.id);
  }
}
