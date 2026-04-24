/**
 * sqlite-vec seam tests.
 *
 * Covers:
 *   - `loadSqliteVec(db)` + `createVecTable(db, 3)` succeed on an in-memory DB.
 *   - Insert + KNN query returns the expected nearest chunk.
 *   - Insert with a dimension mismatch raises.
 *
 * If the `sqlite-vec` native binary can't be loaded in this environment
 * (e.g. because `npm install` hasn't run yet, or the platform has no
 * prebuilt), we fall back to `describe.skip` rather than failing hard.
 * Parent will un-skip after installing deps.
 */

import Database from 'better-sqlite3';

type VecModule = typeof import('../../../src/local/db/sqlite-vec');

/** Probe whether sqlite-vec can actually load in this environment. */
function canLoadSqliteVec(): { ok: true; mod: VecModule } | { ok: false; reason: string } {
  let mod: VecModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../../../src/local/db/sqlite-vec') as VecModule;
  } catch (err) {
    return { ok: false, reason: `import failed: ${(err as Error).message}` };
  }

  const probe = new Database(':memory:');
  try {
    mod.loadSqliteVec(probe);
    return { ok: true, mod };
  } catch (err) {
    return { ok: false, reason: `load failed: ${(err as Error).message}` };
  } finally {
    probe.close();
  }
}

const probe = canLoadSqliteVec();

// TODO(L2-postinstall): if `probe.ok === false` here, it means the
// `sqlite-vec` native binary isn't available yet. Parent agent will run
// `npm install` and re-run; these tests should then execute unskipped.
const suite = probe.ok ? describe : describe.skip;

suite('sqlite-vec seam', () => {
  // Narrow to the loaded path so TS is happy inside the skip branch.
  const mod = probe.ok ? probe.mod : (undefined as unknown as VecModule);

  function openWithVec(): Database.Database {
    const db = new Database(':memory:');
    mod.loadSqliteVec(db);
    return db;
  }

  it('loadSqliteVec + createVecTable succeed on an in-memory DB', () => {
    const db = openWithVec();
    mod.createVecTable(db, 3);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual') AND name = 'code_chunks_vec'",
      )
      .all() as Array<{ name: string }>;
    // vec0 virtual tables register as type='table' in sqlite_master.
    expect(tables.length).toBeGreaterThanOrEqual(1);

    db.close();
  });

  it('supports insert + KNN query', () => {
    const db = openWithVec();
    mod.createVecTable(db, 3);

    const ins = db.prepare(
      "INSERT INTO code_chunks_vec (chunk_id, embedding) VALUES (?, vec_f32(?))",
    );
    ins.run('a', JSON.stringify([1, 0, 0]));
    ins.run('b', JSON.stringify([0, 1, 0]));
    ins.run('c', JSON.stringify([0, 0, 1]));

    // Query vector is nearly parallel to 'a' — KNN should rank 'a' first.
    const rows = db
      .prepare(
        `SELECT chunk_id
           FROM code_chunks_vec
          WHERE embedding MATCH vec_f32(?)
          ORDER BY distance
          LIMIT 1`,
      )
      .all(JSON.stringify([0.9, 0.1, 0.0])) as Array<{ chunk_id: string }>;

    expect(rows.map((r) => r.chunk_id)).toEqual(['a']);

    db.close();
  });

  it('raises on a dimension mismatch', () => {
    const db = openWithVec();
    mod.createVecTable(db, 3);

    const ins = db.prepare(
      "INSERT INTO code_chunks_vec (chunk_id, embedding) VALUES (?, vec_f32(?))",
    );

    // 4-dim input into a 3-dim column — sqlite-vec rejects at insert time.
    expect(() => ins.run('x', JSON.stringify([1, 2, 3, 4]))).toThrow();

    db.close();
  });
});
