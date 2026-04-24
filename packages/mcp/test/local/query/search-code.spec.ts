/**
 * L12 — `search_code` tests.
 *
 * Strategy:
 *   - Use an in-memory DB seeded with both migrations (001_initial +
 *     002_sqlite_vec). If the sqlite-vec native binary can't load in
 *     this environment, the suite `describe.skip`s — matching the
 *     pattern in `test/local/db/sqlite-vec.spec.ts`.
 *   - Use an inline stub embedder that returns CALLER-SUPPLIED vectors.
 *     This lets each test pin the geometry: seed chunks with known
 *     vectors, make the "query vector" exactly parallel to one of them,
 *     assert it ranks first. We don't rely on `MockEmbedder`'s hashed
 *     vectors because we want true semantic distance, not noise.
 *
 * Coverage:
 *   - empty DB → empty results
 *   - closest chunk ranks first with a plausible score
 *   - lexical rerank breaks ties toward the chunk containing query tokens
 *   - `limit` bounds result set below the KNN pool size
 *   - `preview` truncates to 120 chars
 *   - `confidence` is always `'EXTRACTED'`
 */

import Database from 'better-sqlite3';
import { migrate } from '../../../src/local/db/migrator';
import { migration001Initial } from '../../../src/local/db/migrations/001_initial';
import { makeSqliteVecMigration } from '../../../src/local/db/migrations/002_sqlite_vec';
import { searchCode } from '../../../src/local/query/search-code';
import type { Embedder, EmbedRequest, EmbedResponse } from '../../../src/local/embed/types';

/** Tiny 3-dim DB for tests so we can hand-pick vectors intuitively. */
const DIM = 3;

/**
 * Probe sqlite-vec loadability. If the native binary isn't built for
 * this platform we skip the whole suite — same pattern as L2's seam test.
 */
function canLoadSqliteVec(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../../src/local/db/sqlite-vec') as typeof import('../../../src/local/db/sqlite-vec');
    const probe = new Database(':memory:');
    try {
      mod.loadSqliteVec(probe);
      return true;
    } finally {
      probe.close();
    }
  } catch {
    return false;
  }
}

const suite = canLoadSqliteVec() ? describe : describe.skip;

suite('searchCode()', () => {
  /**
   * Open an in-memory DB, run both migrations with `dim = DIM`, and
   * return the handle. Caller seeds rows as needed.
   */
  async function openSeededDb(): Promise<Database.Database> {
    const db = new Database(':memory:');
    await migrate(db, [migration001Initial, makeSqliteVecMigration(DIM)]);
    return db;
  }

  /**
   * Stub embedder that returns a predetermined vector for any input.
   * Tests pin the geometry via the constructor arg.
   */
  class StubEmbedder implements Embedder {
    readonly dimension = DIM;
    constructor(private readonly vec: number[]) {}
    // eslint-disable-next-line @typescript-eslint/require-await
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      return { vectors: req.input.map(() => this.vec.slice()), tokensUsed: 0 };
    }
  }

  /**
   * Insert a chunk + its embedding. Keeps the schema details localized
   * to this helper so each test stays focused on assertions.
   */
  function seedChunk(
    db: Database.Database,
    row: {
      id: string;
      filePath: string;
      lineStart: number;
      lineEnd: number;
      content: string;
      vec: number[];
    },
  ): void {
    db.prepare(
      `INSERT INTO code_chunks (id, file_path, line_start, line_end, content, language, content_hash)
       VALUES (?, ?, ?, ?, ?, 'typescript', ?)`,
    ).run(
      row.id,
      row.filePath,
      row.lineStart,
      row.lineEnd,
      row.content,
      `h:${row.id}`,
    );
    db.prepare(
      `INSERT INTO code_chunks_vec (chunk_id, embedding) VALUES (?, vec_f32(?))`,
    ).run(row.id, JSON.stringify(row.vec));
  }

  it('returns empty results on an empty DB without throwing', async () => {
    const db = await openSeededDb();
    try {
      const res = await searchCode('anything', {
        db,
        embedder: new StubEmbedder([1, 0, 0]),
      });
      expect(res).toEqual({ query: 'anything', results: [] });
    } finally {
      db.close();
    }
  });

  it('ranks the closest chunk first with a confidence_score > 0.5', async () => {
    const db = await openSeededDb();
    try {
      seedChunk(db, {
        id: 'a',
        filePath: 'src/a.ts',
        lineStart: 1,
        lineEnd: 10,
        content: 'function a() {}',
        vec: [1, 0, 0],
      });
      seedChunk(db, {
        id: 'b',
        filePath: 'src/b.ts',
        lineStart: 1,
        lineEnd: 10,
        content: 'function b() {}',
        vec: [0, 1, 0],
      });
      seedChunk(db, {
        id: 'c',
        filePath: 'src/c.ts',
        lineStart: 1,
        lineEnd: 10,
        content: 'function c() {}',
        vec: [0, 0, 1],
      });

      // Query vector parallel to `a` — expect `a` first.
      const res = await searchCode('query', {
        db,
        embedder: new StubEmbedder([0.9, 0.1, 0]),
      });

      expect(res.query).toBe('query');
      expect(res.results.length).toBeGreaterThanOrEqual(1);
      expect(res.results[0].filePath).toBe('src/a.ts');
      expect(res.results[0].confidence_score).toBeGreaterThan(0.5);
    } finally {
      db.close();
    }
  });

  it('applies the lexical rerank bonus to break near-ties', async () => {
    const db = await openSeededDb();
    try {
      // Two chunks equidistant from the query vector. Only one contains
      // the query token. Expect the token-containing chunk first.
      seedChunk(db, {
        id: 'with-token',
        filePath: 'src/with.ts',
        lineStart: 1,
        lineEnd: 5,
        content: 'export function authGuard() { /* authGuard impl */ }',
        vec: [1, 0, 0],
      });
      seedChunk(db, {
        id: 'no-token',
        filePath: 'src/without.ts',
        lineStart: 1,
        lineEnd: 5,
        content: 'export function unrelated() {}',
        vec: [1, 0, 0],
      });

      const res = await searchCode('authGuard', {
        db,
        embedder: new StubEmbedder([1, 0, 0]),
      });

      expect(res.results.length).toBe(2);
      expect(res.results[0].filePath).toBe('src/with.ts');
      expect(res.results[0].confidence_score).toBeGreaterThan(
        res.results[1].confidence_score,
      );
    } finally {
      db.close();
    }
  });

  it('bounds the result set by `limit` even when KNN returns more', async () => {
    const db = await openSeededDb();
    try {
      for (let i = 0; i < 5; i++) {
        seedChunk(db, {
          id: `r${i}`,
          filePath: `src/r${i}.ts`,
          lineStart: 1,
          lineEnd: 1,
          content: `chunk ${i}`,
          // Spread across the unit cube so each has a distinct distance.
          vec: [i / 5, (5 - i) / 5, 0],
        });
      }

      const res = await searchCode('hi', {
        db,
        embedder: new StubEmbedder([1, 0, 0]),
        limit: 2,
        knnCandidates: 20,
      });

      expect(res.results).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('truncates preview to 120 characters', async () => {
    const db = await openSeededDb();
    try {
      const longContent = 'x'.repeat(500);
      seedChunk(db, {
        id: 'long',
        filePath: 'src/long.ts',
        lineStart: 1,
        lineEnd: 500,
        content: longContent,
        vec: [1, 0, 0],
      });

      const res = await searchCode('anything', {
        db,
        embedder: new StubEmbedder([1, 0, 0]),
      });

      expect(res.results).toHaveLength(1);
      expect(res.results[0].preview.length).toBe(120);
      expect(res.results[0].preview).toBe('x'.repeat(120));
    } finally {
      db.close();
    }
  });

  it("tags every result with confidence: 'EXTRACTED'", async () => {
    const db = await openSeededDb();
    try {
      seedChunk(db, {
        id: 'x',
        filePath: 'src/x.ts',
        lineStart: 1,
        lineEnd: 1,
        content: 'noop',
        vec: [1, 0, 0],
      });
      seedChunk(db, {
        id: 'y',
        filePath: 'src/y.ts',
        lineStart: 1,
        lineEnd: 1,
        content: 'noop',
        vec: [0, 1, 0],
      });

      const res = await searchCode('anything', {
        db,
        embedder: new StubEmbedder([0.5, 0.5, 0]),
      });

      expect(res.results.length).toBeGreaterThan(0);
      for (const r of res.results) {
        expect(r.confidence).toBe('EXTRACTED');
      }
    } finally {
      db.close();
    }
  });
});
