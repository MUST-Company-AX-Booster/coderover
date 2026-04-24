/**
 * L14 — `find_dependencies` tests.
 *
 * Pure SQL over `imports`. No vec0, no embedder.
 *
 * Coverage:
 *   - empty DB → both arrays empty
 *   - downstream/upstream lookup on file paths
 *   - DISTINCT dedupes duplicate edges
 *   - bare module name matches the `pkg:<name>` key used by Wave 2
 *   - every entry tagged `EXTRACTED` / 1.0
 */

import Database from 'better-sqlite3';
import { migrate } from '../../../src/local/db/migrator';
import { migration001Initial } from '../../../src/local/db/migrations/001_initial';
import { findDependencies } from '../../../src/local/query/find-dependencies';

async function openSeededDb(): Promise<Database.Database> {
  const db = new Database(':memory:');
  await migrate(db, [migration001Initial]);
  return db;
}

/** Insert one import edge. Uses the edge_id as a primary key discriminator. */
function seedImport(
  db: Database.Database,
  args: { edgeId: string; srcFile: string; targetPath: string },
): void {
  db.prepare(
    `INSERT INTO imports (edge_id, src_file, target_path, confidence)
     VALUES (?, ?, ?, 'EXTRACTED')`,
  ).run(args.edgeId, args.srcFile, args.targetPath);
}

describe('findDependencies()', () => {
  it('returns both arrays empty on an empty DB', async () => {
    const db = await openSeededDb();
    try {
      const res = findDependencies('src/missing.ts', { db });
      expect(res).toEqual({
        target: 'src/missing.ts',
        upstream: [],
        downstream: [],
      });
    } finally {
      db.close();
    }
  });

  it('resolves downstream (what target imports) and upstream (who imports target)', async () => {
    const db = await openSeededDb();
    try {
      // a.ts imports b.ts — so:
      //   findDependencies('a.ts').downstream → [b.ts]
      //   findDependencies('b.ts').upstream   → [a.ts]
      seedImport(db, {
        edgeId: 'e1',
        srcFile: 'a.ts',
        targetPath: 'b.ts',
      });

      const aDeps = findDependencies('a.ts', { db });
      expect(aDeps.downstream.map((d) => d.filePath)).toEqual(['b.ts']);
      expect(aDeps.upstream).toEqual([]);

      const bDeps = findDependencies('b.ts', { db });
      expect(bDeps.upstream.map((u) => u.filePath)).toEqual(['a.ts']);
      expect(bDeps.downstream).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('dedupes duplicate edges via DISTINCT', async () => {
    const db = await openSeededDb();
    try {
      // Two rows with the same (src_file, target_path). Real ingest
      // wouldn't produce this (Wave 2 dedupes during extraction), but
      // the DISTINCT guards against manual rows / future changes.
      seedImport(db, {
        edgeId: 'dup-1',
        srcFile: 'a.ts',
        targetPath: 'b.ts',
      });
      seedImport(db, {
        edgeId: 'dup-2',
        srcFile: 'a.ts',
        targetPath: 'b.ts',
      });

      const res = findDependencies('a.ts', { db });
      expect(res.downstream).toHaveLength(1);
      expect(res.downstream[0].filePath).toBe('b.ts');
    } finally {
      db.close();
    }
  });

  it('matches a bare module name against the pkg:<name> key', async () => {
    const db = await openSeededDb();
    try {
      // Wave 2's resolver stores bare specifiers as `pkg:lodash`.
      // `findDependencies('lodash')` should find the file that imports it.
      seedImport(db, {
        edgeId: 'e-lodash',
        srcFile: 'a.ts',
        targetPath: 'pkg:lodash',
      });

      const res = findDependencies('lodash', { db });
      expect(res.upstream.map((u) => u.filePath)).toEqual(['a.ts']);
      expect(res.downstream).toEqual([]);
      // Target echoed back unchanged — no `pkg:` leak into the response.
      expect(res.target).toBe('lodash');
    } finally {
      db.close();
    }
  });

  it('matches scoped npm packages (`@scope/name`) via pkg: prefix', async () => {
    const db = await openSeededDb();
    try {
      seedImport(db, {
        edgeId: 'e-nest',
        srcFile: 'src/app.module.ts',
        targetPath: 'pkg:@nestjs/common',
      });

      const res = findDependencies('@nestjs/common', { db });
      expect(res.upstream.map((u) => u.filePath)).toEqual(['src/app.module.ts']);
    } finally {
      db.close();
    }
  });

  it('tags every entry with EXTRACTED / 1.0', async () => {
    const db = await openSeededDb();
    try {
      seedImport(db, { edgeId: 'e-up', srcFile: 'x.ts', targetPath: 'y.ts' });
      seedImport(db, { edgeId: 'e-down', srcFile: 'y.ts', targetPath: 'z.ts' });

      const res = findDependencies('y.ts', { db });

      expect(res.upstream).toHaveLength(1);
      expect(res.downstream).toHaveLength(1);
      for (const e of [...res.upstream, ...res.downstream]) {
        expect(e.confidence).toBe('EXTRACTED');
        expect(e.confidence_score).toBe(1.0);
      }
    } finally {
      db.close();
    }
  });
});
