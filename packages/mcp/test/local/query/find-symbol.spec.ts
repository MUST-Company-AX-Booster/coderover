/**
 * L13 — `find_symbol` tests.
 *
 * No sqlite-vec needed — this is pure row-level SQL over `symbols` +
 * `code_chunks`. We seed directly with hand-picked rows so the tests
 * don't depend on the Wave 2 extractor.
 *
 * Coverage:
 *   - empty DB → totalFound: 0
 *   - exact short-name match
 *   - qualified prefix match (`Foo` → `Foo.bar`)
 *   - qualified suffix match (`bar` → `Foo.bar`)
 *   - exact match ranks ahead of partial when both exist
 *   - `node_id` round-trips from `symbols.node_id` verbatim
 *   - `limit` bounds results
 */

import Database from 'better-sqlite3';
import { migrate } from '../../../src/local/db/migrator';
import { migration001Initial } from '../../../src/local/db/migrations/001_initial';
import { findSymbol } from '../../../src/local/query/find-symbol';

/**
 * Open an in-memory DB with only migration 001 applied. `find_symbol`
 * never touches the vec0 virtual table, so we skip migration 002 —
 * keeps the test suite independent of the sqlite-vec native binary.
 */
async function openSeededDb(): Promise<Database.Database> {
  const db = new Database(':memory:');
  await migrate(db, [migration001Initial]);
  return db;
}

/** Seed one chunk + one symbol. Returns the symbol's node_id. */
function seedSymbol(
  db: Database.Database,
  args: {
    nodeId: string;
    chunkId: string;
    filePath: string;
    lineStart: number;
    lineEnd: number;
    kind: string;
    name: string;
    qualified: string;
  },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO code_chunks (id, file_path, line_start, line_end, content, language, content_hash)
     VALUES (?, ?, ?, ?, '', 'typescript', ?)`,
  ).run(
    args.chunkId,
    args.filePath,
    args.lineStart,
    args.lineEnd,
    `h:${args.chunkId}`,
  );
  db.prepare(
    `INSERT INTO symbols (node_id, chunk_id, kind, name, qualified)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(args.nodeId, args.chunkId, args.kind, args.name, args.qualified);
}

describe('findSymbol()', () => {
  it('returns an empty response on an empty DB', async () => {
    const db = await openSeededDb();
    try {
      const res = findSymbol('AuthService', { db });
      expect(res).toEqual({
        symbolName: 'AuthService',
        results: [],
        totalFound: 0,
      });
    } finally {
      db.close();
    }
  });

  it('matches an exact short name', async () => {
    const db = await openSeededDb();
    try {
      seedSymbol(db, {
        nodeId: 'node-auth',
        chunkId: 'chunk-auth',
        filePath: 'src/auth.service.ts',
        lineStart: 1,
        lineEnd: 42,
        kind: 'class',
        name: 'AuthService',
        qualified: 'AuthService',
      });

      const res = findSymbol('AuthService', { db });

      expect(res.totalFound).toBe(1);
      expect(res.results[0].filePath).toBe('src/auth.service.ts');
      expect(res.results[0].lineStart).toBe(1);
      expect(res.results[0].lineEnd).toBe(42);
    } finally {
      db.close();
    }
  });

  it('matches a qualified-name prefix (container name)', async () => {
    const db = await openSeededDb();
    try {
      // `Foo.bar` should come up when the caller types `Foo`.
      seedSymbol(db, {
        nodeId: 'node-foo-bar',
        chunkId: 'chunk-foo-bar',
        filePath: 'src/foo.ts',
        lineStart: 10,
        lineEnd: 20,
        kind: 'method',
        name: 'bar',
        qualified: 'Foo.bar',
      });

      const res = findSymbol('Foo', { db });

      expect(res.totalFound).toBe(1);
      expect(res.results[0].filePath).toBe('src/foo.ts');
    } finally {
      db.close();
    }
  });

  it('matches a qualified-name suffix (member name)', async () => {
    const db = await openSeededDb();
    try {
      // `Foo.bar` should come up when the caller types just `bar`.
      // (The short `name` column here is `bar` too, so this test also
      // confirms the `name = ?` OR branch lights up — but the key is
      // that `qualified LIKE '%.' || 'bar'` also matches and we don't
      // double-count.)
      seedSymbol(db, {
        nodeId: 'node-foo-bar',
        chunkId: 'chunk-foo-bar',
        filePath: 'src/foo.ts',
        lineStart: 10,
        lineEnd: 20,
        kind: 'method',
        name: 'bar',
        qualified: 'Foo.bar',
      });

      const res = findSymbol('bar', { db });

      expect(res.totalFound).toBe(1);
      expect(res.results[0].filePath).toBe('src/foo.ts');
    } finally {
      db.close();
    }
  });

  it('ranks exact-name matches ahead of partial matches', async () => {
    const db = await openSeededDb();
    try {
      // `Widget` (exact) and `Widget.render` (prefix partial) both exist.
      // Exact match should come first.
      seedSymbol(db, {
        nodeId: 'node-widget-class',
        chunkId: 'chunk-widget-class',
        filePath: 'src/widget.ts',
        lineStart: 1,
        lineEnd: 100,
        kind: 'class',
        name: 'Widget',
        qualified: 'Widget',
      });
      seedSymbol(db, {
        nodeId: 'node-widget-render',
        chunkId: 'chunk-widget-render',
        filePath: 'src/widget.ts',
        lineStart: 10,
        lineEnd: 20,
        kind: 'method',
        name: 'render',
        qualified: 'Widget.render',
      });

      const res = findSymbol('Widget', { db });

      expect(res.totalFound).toBe(2);
      // Exact match first.
      expect(res.results[0].node_id).toBe('node-widget-class');
      expect(res.results[1].node_id).toBe('node-widget-render');
    } finally {
      db.close();
    }
  });

  it('returns the node_id verbatim from the symbols table', async () => {
    const db = await openSeededDb();
    try {
      const stableId = 'deterministic-id-abc123';
      seedSymbol(db, {
        nodeId: stableId,
        chunkId: 'c1',
        filePath: 'src/x.ts',
        lineStart: 1,
        lineEnd: 1,
        kind: 'function',
        name: 'doThing',
        qualified: 'doThing',
      });

      const res = findSymbol('doThing', { db });

      // Exact round-trip — no recomputation, no case change.
      expect(res.results[0].node_id).toBe(stableId);
    } finally {
      db.close();
    }
  });

  it('bounds results via `limit`', async () => {
    const db = await openSeededDb();
    try {
      for (let i = 0; i < 5; i++) {
        seedSymbol(db, {
          nodeId: `node-${i}`,
          chunkId: `chunk-${i}`,
          filePath: `src/f${i}.ts`,
          lineStart: 1,
          lineEnd: 1,
          kind: 'method',
          name: 'doit',
          qualified: `Cls${i}.doit`,
        });
      }

      const res = findSymbol('doit', { db, limit: 2 });

      expect(res.totalFound).toBe(2);
      expect(res.results).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("tags every result with confidence: 'EXTRACTED' and score 1.0", async () => {
    const db = await openSeededDb();
    try {
      seedSymbol(db, {
        nodeId: 'n1',
        chunkId: 'c1',
        filePath: 'src/a.ts',
        lineStart: 1,
        lineEnd: 1,
        kind: 'class',
        name: 'A',
        qualified: 'A',
      });

      const res = findSymbol('A', { db });

      expect(res.results[0].confidence).toBe('EXTRACTED');
      expect(res.results[0].confidence_score).toBe(1.0);
    } finally {
      db.close();
    }
  });

  // Bug #3: prevent SQL LIKE-wildcard bypass. The 0.4.0 empty-string
  // check closed the `find_symbol("")` loophole, but the bound LIKE
  // values still treat `%` and `_` as wildcards — so `find_symbol("%")`
  // matched every symbol in the index. The query must escape `%`/`_`
  // (and the escape char itself) when binding LIKE patterns.
  describe('LIKE-wildcard escape', () => {
    function seedTwo(db: Database.Database): void {
      seedSymbol(db, {
        nodeId: 'n1',
        chunkId: 'c1',
        filePath: 'src/a.ts',
        lineStart: 1,
        lineEnd: 1,
        kind: 'class',
        name: 'AuthService',
        qualified: 'AuthService',
      });
      seedSymbol(db, {
        nodeId: 'n2',
        chunkId: 'c2',
        filePath: 'src/b.ts',
        lineStart: 1,
        lineEnd: 1,
        kind: 'function',
        name: 'verify',
        qualified: 'AuthService.verify',
      });
    }

    it('returns no results for a bare "%" wildcard query', async () => {
      const db = await openSeededDb();
      try {
        seedTwo(db);
        const res = findSymbol('%', { db });
        expect(res.totalFound).toBe(0);
        expect(res.results).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('returns no results for a bare "_" wildcard query', async () => {
      const db = await openSeededDb();
      try {
        seedTwo(db);
        const res = findSymbol('_', { db });
        expect(res.totalFound).toBe(0);
        expect(res.results).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('still matches a literal "%" in a symbol name when explicitly typed', async () => {
      const db = await openSeededDb();
      try {
        seedSymbol(db, {
          nodeId: 'n1',
          chunkId: 'c1',
          filePath: 'src/weird.ts',
          lineStart: 1,
          lineEnd: 1,
          kind: 'function',
          name: 'odd%name',
          qualified: 'odd%name',
        });
        const res = findSymbol('odd%name', { db });
        expect(res.totalFound).toBe(1);
        expect(res.results[0].filePath).toBe('src/weird.ts');
      } finally {
        db.close();
      }
    });

    it('does not let "Auth%" sneak through as a prefix wildcard', async () => {
      const db = await openSeededDb();
      try {
        seedTwo(db);
        // `Auth%` should be treated literally — neither symbol's name
        // nor qualified is `Auth%`, so no match.
        const res = findSymbol('Auth%', { db });
        expect(res.totalFound).toBe(0);
      } finally {
        db.close();
      }
    });

    it('still matches a literal "_" in a symbol name (not as wildcard)', async () => {
      const db = await openSeededDb();
      try {
        // `_` is the SQL "any single char" wildcard. Pre-fix
        // `findSymbol("foo_bar")` matched both `foo_bar` and `fooXbar`.
        // Post-fix only the literal-underscore row matches.
        seedSymbol(db, {
          nodeId: 'n1',
          chunkId: 'c1',
          filePath: 'src/snake.ts',
          lineStart: 1,
          lineEnd: 1,
          kind: 'function',
          name: 'foo_bar',
          qualified: 'foo_bar',
        });
        seedSymbol(db, {
          nodeId: 'n2',
          chunkId: 'c2',
          filePath: 'src/x.ts',
          lineStart: 1,
          lineEnd: 1,
          kind: 'function',
          name: 'fooXbar',
          qualified: 'fooXbar',
        });
        const res = findSymbol('foo_bar', { db });
        expect(res.totalFound).toBe(1);
        expect(res.results[0].filePath).toBe('src/snake.ts');
      } finally {
        db.close();
      }
    });

    it('handles a literal backslash without mangling subsequent escapes', async () => {
      // escapeLikePattern does \\ → \\\\ FIRST so subsequent %→\\% and
      // _→\\_ passes don't double-escape. A regression that reordered
      // the chain would silently break literal-backslash queries.
      const db = await openSeededDb();
      try {
        seedSymbol(db, {
          nodeId: 'n1',
          chunkId: 'c1',
          filePath: 'src/path.ts',
          lineStart: 1,
          lineEnd: 1,
          kind: 'function',
          name: 'win\\path',
          qualified: 'win\\path',
        });
        const res = findSymbol('win\\path', { db });
        expect(res.totalFound).toBe(1);
        expect(res.results[0].filePath).toBe('src/path.ts');
      } finally {
        db.close();
      }
    });

    it('handles a string with all three metachars (\\, %, _)', async () => {
      // The combined-input case — locks the .replace() chain order.
      // If `%` or `_` were escaped before `\`, the escape-prefix the
      // first pass injected would itself be re-escaped on the next pass.
      const db = await openSeededDb();
      try {
        seedSymbol(db, {
          nodeId: 'n1',
          chunkId: 'c1',
          filePath: 'src/funky.ts',
          lineStart: 1,
          lineEnd: 1,
          kind: 'function',
          name: 'a\\b%c_d',
          qualified: 'a\\b%c_d',
        });
        seedSymbol(db, {
          nodeId: 'n2',
          chunkId: 'c2',
          filePath: 'src/other.ts',
          lineStart: 1,
          lineEnd: 1,
          kind: 'function',
          name: 'aXbYcZd',
          qualified: 'aXbYcZd',
        });
        const res = findSymbol('a\\b%c_d', { db });
        expect(res.totalFound).toBe(1);
        expect(res.results[0].filePath).toBe('src/funky.ts');
      } finally {
        db.close();
      }
    });
  });
});
