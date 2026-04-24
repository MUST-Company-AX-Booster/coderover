/**
 * Migration runner tests.
 *
 * Covers:
 *   - Fresh DB: ledger table created, both built-in migrations recorded.
 *   - Idempotency: re-running leaves the DB unchanged.
 *   - Incremental: adding a third migration only runs the new one.
 *   - Atomicity: a migration that throws rolls back the transaction and
 *     does not record a ledger row.
 *   - Uniqueness: duplicate ids throw at runtime.
 *   - Ordering: migrations run in the order supplied, not sorted.
 */

import Database from 'better-sqlite3';
import { migrate, type Migration } from '../../../src/local/db/migrator';
import { migration001Initial } from '../../../src/local/db/migrations/001_initial';

function freshDb(): Database.Database {
  // `:memory:` gives each test a clean, isolated DB with no fs side effects.
  return new Database(':memory:');
}

function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function appliedIds(db: Database.Database): string[] {
  const rows = db
    .prepare('SELECT id FROM _migrations ORDER BY id')
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

describe('migrate()', () => {
  it('creates the _migrations ledger and applies the initial migration', async () => {
    const db = freshDb();
    const applied = await migrate(db, [migration001Initial]);

    expect(applied).toEqual(['001_initial']);
    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        '_migrations',
        'code_chunks',
        'file_hashes',
        'imports',
        'symbols',
      ]),
    );
    expect(appliedIds(db)).toEqual(['001_initial']);

    db.close();
  });

  it('is idempotent: re-running with the same list is a no-op', async () => {
    const db = freshDb();
    await migrate(db, [migration001Initial]);

    const second = await migrate(db, [migration001Initial]);

    expect(second).toEqual([]);
    expect(appliedIds(db)).toEqual(['001_initial']);

    db.close();
  });

  it('applies only newly-added migrations on a subsequent run', async () => {
    const db = freshDb();
    await migrate(db, [migration001Initial]);

    const mThird: Migration = {
      id: '003_scratch',
      up(d) {
        d.prepare('CREATE TABLE scratch (id INTEGER PRIMARY KEY)').run();
      },
    };

    const applied = await migrate(db, [migration001Initial, mThird]);

    expect(applied).toEqual(['003_scratch']);
    expect(appliedIds(db)).toEqual(['001_initial', '003_scratch']);
    expect(tableNames(db)).toContain('scratch');

    db.close();
  });

  it('rolls back and leaves no ledger row when a migration throws', async () => {
    const db = freshDb();

    const mBoom: Migration = {
      id: '002_boom',
      up(d) {
        // This table is created first...
        d.prepare('CREATE TABLE should_not_exist (id INTEGER)').run();
        // ...but the throw rolls it back along with the ledger insert.
        throw new Error('intentional failure');
      },
    };

    await expect(migrate(db, [mBoom])).rejects.toThrow(/002_boom/);

    // Ledger exists (we create it before the loop) but the failing id is
    // not present, and the table created inside the transaction is gone.
    expect(tableNames(db)).toEqual(['_migrations']);
    expect(appliedIds(db)).toEqual([]);

    db.close();
  });

  it('throws on duplicate migration ids before touching the DB', async () => {
    const db = freshDb();
    const dupA: Migration = { id: 'same', up: () => {} };
    const dupB: Migration = { id: 'same', up: () => {} };

    await expect(migrate(db, [dupA, dupB])).rejects.toThrow(/Duplicate migration id/);

    // Guard: we intentionally validate before creating the ledger, so the
    // DB should still be empty.
    expect(tableNames(db)).toEqual([]);

    db.close();
  });

  it('runs migrations in the order supplied, not sorted by id', async () => {
    const db = freshDb();
    const order: string[] = [];

    const mBeta: Migration = {
      id: 'b_beta',
      up: () => {
        order.push('b_beta');
      },
    };
    const mAlpha: Migration = {
      id: 'a_alpha',
      up: () => {
        order.push('a_alpha');
      },
    };

    // Intentionally pass beta-before-alpha: the runner must preserve this.
    await migrate(db, [mBeta, mAlpha]);

    expect(order).toEqual(['b_beta', 'a_alpha']);

    db.close();
  });
});
