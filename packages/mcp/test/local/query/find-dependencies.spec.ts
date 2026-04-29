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
import { migration003CallEdges } from '../../../src/local/db/migrations/003_call_edges';
import { findDependencies } from '../../../src/local/query/find-dependencies';

async function openSeededDb(): Promise<Database.Database> {
  const db = new Database(':memory:');
  await migrate(db, [migration001Initial, migration003CallEdges]);
  return db;
}

/** Insert one call edge. Mirrors the pipeline's INSERT shape. */
function seedCall(
  db: Database.Database,
  args: {
    edgeId: string;
    callerNodeId: string;
    callerQualified: string;
    calleeName: string;
    calleeQualified: string | null;
    srcFile: string;
    line: number;
  },
): void {
  db.prepare(
    `INSERT INTO call_edges (edge_id, caller_node_id, caller_qualified,
                             callee_name, callee_qualified, src_file,
                             call_line, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'EXTRACTED')`,
  ).run(
    args.edgeId,
    args.callerNodeId,
    args.callerQualified,
    args.calleeName,
    args.calleeQualified,
    args.srcFile,
    args.line,
  );
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
        targetKind: 'file',
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

  it('explicit `pkg:<name>` target matches the imports table verbatim', async () => {
    const db = await openSeededDb();
    try {
      // 0.5.0 dispatch: bare `lodash` now routes to symbol-grain;
      // explicit `pkg:lodash` is the unambiguous way to query the
      // imports table for a bare-module specifier.
      seedImport(db, {
        edgeId: 'e-lodash',
        srcFile: 'a.ts',
        targetPath: 'pkg:lodash',
      });

      const res = findDependencies('pkg:lodash', { db });
      expect(res.targetKind).toBe('file');
      expect(res.upstream.map((u) => u.filePath)).toEqual(['a.ts']);
      expect(res.downstream).toEqual([]);
      expect(res.target).toBe('pkg:lodash');
    } finally {
      db.close();
    }
  });

  it('scoped npm packages (`@scope/name`) match via the imports table', async () => {
    const db = await openSeededDb();
    try {
      seedImport(db, {
        edgeId: 'e-nest',
        srcFile: 'src/app.module.ts',
        targetPath: 'pkg:@nestjs/common',
      });

      // `@scope/name` shape is recognised as file-grain by classifyTarget;
      // the file-grain branch then rewrites bare `@scope/name` to
      // `pkg:@scope/name` for the upstream lookup.
      const res = findDependencies('@nestjs/common', { db });
      expect(res.targetKind).toBe('file');
      expect(res.upstream.map((u) => u.filePath)).toEqual([
        'src/app.module.ts',
      ]);
    } finally {
      db.close();
    }
  });

  // ─── 0.5.0 — symbol-grain (B5) ────────────────────────────────────────

  it('symbol-grain upstream: returns callers of a qualified symbol', async () => {
    const db = await openSeededDb();
    try {
      // AuthController.login calls AuthService.verify on line 42.
      seedCall(db, {
        edgeId: 'e1',
        callerNodeId: 'n-controller-login',
        callerQualified: 'AuthController.login',
        calleeName: 'verify',
        calleeQualified: 'AuthService.verify',
        srcFile: 'src/auth/auth.controller.ts',
        line: 42,
      });

      const res = findDependencies('AuthService.verify', { db });
      expect(res.targetKind).toBe('symbol');
      expect(res.upstream).toEqual([
        {
          filePath: 'src/auth/auth.controller.ts',
          symbol: 'AuthController.login',
          line: 42,
          confidence: 'EXTRACTED',
          confidence_score: 1,
        },
      ]);
      expect(res.downstream).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('symbol-grain upstream: bare-name target also matches calls with qualified callees', async () => {
    const db = await openSeededDb();
    try {
      // Same edge — but the user typed `verify` instead of `AuthService.verify`.
      seedCall(db, {
        edgeId: 'e1',
        callerNodeId: 'n-controller-login',
        callerQualified: 'AuthController.login',
        calleeName: 'verify',
        calleeQualified: 'AuthService.verify',
        srcFile: 'src/auth/auth.controller.ts',
        line: 42,
      });

      const res = findDependencies('verify', { db });
      expect(res.targetKind).toBe('symbol');
      expect(res.upstream.map((u) => u.symbol)).toEqual([
        'AuthController.login',
      ]);
    } finally {
      db.close();
    }
  });

  it('symbol-grain downstream: returns callees of a qualified caller', async () => {
    const db = await openSeededDb();
    try {
      // AuthService.verify calls findUser at line 12 and hashPassword at line 18.
      seedCall(db, {
        edgeId: 'e1',
        callerNodeId: 'n-svc-verify',
        callerQualified: 'AuthService.verify',
        calleeName: 'findUser',
        calleeQualified: null,
        srcFile: 'src/auth/auth.service.ts',
        line: 12,
      });
      seedCall(db, {
        edgeId: 'e2',
        callerNodeId: 'n-svc-verify',
        callerQualified: 'AuthService.verify',
        calleeName: 'hashPassword',
        calleeQualified: null,
        srcFile: 'src/auth/auth.service.ts',
        line: 18,
      });

      const res = findDependencies('AuthService.verify', { db });
      expect(res.targetKind).toBe('symbol');
      // Sorted by call_line — the prepared statement's ORDER BY.
      expect(res.downstream.map((d) => `${d.symbol}@${d.line}`)).toEqual([
        'findUser@12',
        'hashPassword@18',
      ]);
      expect(res.upstream).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('classifies file paths as file-grain (regression: do not hit call_edges)', async () => {
    const db = await openSeededDb();
    try {
      // If `src/foo.ts` is misclassified as a symbol, the call_edges
      // SELECT runs and (correctly) returns nothing — but we want to
      // assert the targetKind explicitly.
      const res = findDependencies('src/foo.ts', { db });
      expect(res.targetKind).toBe('file');
    } finally {
      db.close();
    }
  });

  it('classifies dotted-identifier targets as symbols', async () => {
    const db = await openSeededDb();
    try {
      const res = findDependencies('AuthService.verify', { db });
      expect(res.targetKind).toBe('symbol');
    } finally {
      db.close();
    }
  });

  it('classifies bare identifiers (no dot, no slash) as symbol-grain (0.5.0)', async () => {
    const db = await openSeededDb();
    try {
      // Documented 0.5.0 behaviour change: bare names route to
      // symbol-grain. To query bare-module imports, callers pass the
      // explicit `pkg:<name>` form.
      const res = findDependencies('hashPassword', { db });
      expect(res.targetKind).toBe('symbol');
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
