/**
 * Pipeline tests — Phase 11 Wave 4 L16.
 *
 * Exercises the full ingest pipeline end-to-end against a real SQLite
 * DB (in a tmpdir, since sqlite-vec needs a file path with WAL). The
 * tree-sitter-dependent tests are gated on `TS_REAL=1` to match the
 * rest of the Wave 2/3 suite — tree-sitter's native binding has
 * cross-spec invalidation that flakes under shared workers.
 *
 * `removeFile` is pure SQL and doesn't need tree-sitter, so it runs
 * unconditionally so CI has at least one green pipeline test even when
 * TS_REAL is unset.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import Database from 'better-sqlite3';

import {
  indexRepo,
  indexFile,
  removeFile,
  vectorToBuffer,
} from '../../src/local/pipeline';
import { openDb } from '../../src/local/db/open';
import { migrate } from '../../src/local/db/migrator';
import { migration001Initial } from '../../src/local/db/migrations/001_initial';
import { migration002SqliteVec } from '../../src/local/db/migrations/002_sqlite_vec';
import { migration003CallEdges } from '../../src/local/db/migrations/003_call_edges';
import { loadSqliteVec } from '../../src/local/db/sqlite-vec';
import { MockEmbedder } from '../../src/local/embed/embedder';
import type { Embedder } from '../../src/local/embed/types';
import { treeSitterAvailable } from '../helpers/tree-sitter-singleton';

const describeIfTs = treeSitterAvailable() ? describe : describe.skip;

async function openTestDb(): Promise<{ db: Database.Database; cleanup: () => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pipeline-'));
  const dbPath = path.join(dir, 'local.db');
  const db = openDb(dbPath);
  await migrate(db, [
    migration001Initial,
    migration002SqliteVec,
    migration003CallEdges,
  ]);
  loadSqliteVec(db);
  return {
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedRepo(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pipeline-repo-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const SAMPLE = {
  'src/a.ts': `export function alpha(): number { return 1; }\n`,
  'src/b.ts': `export function beta(): number { return 2; }\n`,
  'src/c.ts': `export class Gamma {\n  run(): number { return 3; }\n}\n`,
};

describeIfTs('indexRepo (real tree-sitter)', () => {
  it('ingests a 3-file repo and populates chunk/hash tables', async () => {
    const { db, cleanup: closeDb } = await openTestDb();
    const { root, cleanup: rmRoot } = seedRepo(SAMPLE);
    try {
      const embedder = new MockEmbedder();
      const result = await indexRepo({ db, embedder, rootPath: root });

      expect(result.files).toBe(3);
      expect(result.filesIndexed).toBe(3);
      expect(result.filesSkipped).toBe(0);
      expect(result.chunks).toBeGreaterThan(0);
      expect(result.symbols).toBeGreaterThan(0);

      const chunkCount = (
        db.prepare('SELECT COUNT(*) as c FROM code_chunks').get() as { c: number }
      ).c;
      expect(chunkCount).toBe(result.chunks);

      const hashes = db
        .prepare('SELECT file_path, sha256 FROM file_hashes ORDER BY file_path')
        .all() as Array<{ file_path: string; sha256: string }>;
      expect(hashes.map((r) => r.file_path)).toEqual(
        ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      );
      for (const h of hashes) expect(h.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmRoot();
      closeDb();
    }
  });

  it('incremental: re-running on an unchanged repo skips every file', async () => {
    const { db, cleanup: closeDb } = await openTestDb();
    const { root, cleanup: rmRoot } = seedRepo(SAMPLE);
    try {
      const embedder = new MockEmbedder();
      await indexRepo({ db, embedder, rootPath: root });
      const chunksAfterFirst = (
        db.prepare('SELECT COUNT(*) as c FROM code_chunks').get() as { c: number }
      ).c;

      const second = await indexRepo({ db, embedder, rootPath: root });
      expect(second.filesSkipped).toBe(second.files);
      expect(second.filesIndexed).toBe(0);

      // Row count unchanged — no stale duplicates inserted.
      const chunksAfterSecond = (
        db.prepare('SELECT COUNT(*) as c FROM code_chunks').get() as { c: number }
      ).c;
      expect(chunksAfterSecond).toBe(chunksAfterFirst);
    } finally {
      rmRoot();
      closeDb();
    }
  });

  it('indexFile returns skipped=true when the file hasn’t changed', async () => {
    const { db, cleanup: closeDb } = await openTestDb();
    const { root, cleanup: rmRoot } = seedRepo(SAMPLE);
    try {
      const embedder = new MockEmbedder();
      await indexRepo({ db, embedder, rootPath: root });

      const abs = path.join(root, 'src/a.ts');
      const result = await indexFile({
        db,
        embedder,
        absolutePath: abs,
        repoRoot: root,
      });
      expect(result.skipped).toBe(true);
      expect(result.chunks).toBe(0);
    } finally {
      rmRoot();
      closeDb();
    }
  });

  it('indexFile reingests when the bytes change', async () => {
    const { db, cleanup: closeDb } = await openTestDb();
    const { root, cleanup: rmRoot } = seedRepo(SAMPLE);
    try {
      const embedder = new MockEmbedder();
      await indexRepo({ db, embedder, rootPath: root });

      const abs = path.join(root, 'src/a.ts');
      const oldHash = (
        db
          .prepare('SELECT sha256 FROM file_hashes WHERE file_path = ?')
          .get('src/a.ts') as { sha256: string }
      ).sha256;

      // Rewrite the file with different content.
      fs.writeFileSync(abs, 'export function alpha(): number { return 42; }\n', 'utf8');
      const result = await indexFile({
        db,
        embedder,
        absolutePath: abs,
        repoRoot: root,
      });
      expect(result.skipped).toBe(false);
      expect(result.chunks).toBeGreaterThan(0);

      const newHash = (
        db
          .prepare('SELECT sha256 FROM file_hashes WHERE file_path = ?')
          .get('src/a.ts') as { sha256: string }
      ).sha256;
      expect(newHash).not.toBe(oldHash);
    } finally {
      rmRoot();
      closeDb();
    }
  });

  it('embedder failure propagates from indexRepo', async () => {
    const { db, cleanup: closeDb } = await openTestDb();
    const { root, cleanup: rmRoot } = seedRepo(SAMPLE);
    try {
      const failing: Embedder = {
        dimension: 1536,
        async embed() {
          throw new Error('embed boom');
        },
      };
      await expect(indexRepo({ db, embedder: failing, rootPath: root })).rejects.toThrow(
        'embed boom',
      );
    } finally {
      rmRoot();
      closeDb();
    }
  });

  it('onProgress fires once per file', async () => {
    const { db, cleanup: closeDb } = await openTestDb();
    const { root, cleanup: rmRoot } = seedRepo(SAMPLE);
    try {
      const embedder = new MockEmbedder();
      const progress: Array<{ file: string; skipped: boolean }> = [];
      const result = await indexRepo({
        db,
        embedder,
        rootPath: root,
        onProgress: (p) => progress.push({ file: p.file, skipped: p.skipped }),
      });
      expect(progress.length).toBe(result.files);
      expect(progress.every((p) => !p.skipped)).toBe(true);
    } finally {
      rmRoot();
      closeDb();
    }
  });

  it('indexes a multi-file corpus with a single-line class (regression: vec0 UNIQUE)', async () => {
    // Regression for the chunk-ID collision that surfaced as
    // "UNIQUE constraint failed on code_chunks_vec primary key" — a
    // single-line class emits a class chunk AND a method chunk with the
    // same (filePath, lineStart, lineEnd), so both hashed to the same
    // chunk_id and vec0 (which ignores INSERT OR REPLACE) rejected the
    // second insert. Cross-file corpus mirrors the original bug report.
    const { db, cleanup: closeDb } = await openTestDb();
    const { root, cleanup: rmRoot } = seedRepo({
      'src/a.ts':
        'export function greet(name: string): string { return `hi, ${name}`; }\n' +
        'export class Agent { patrol(): void { console.log("[scout] armed"); } }\n',
      'src/b.py':
        'def patrol():\n' +
        '    print("[sentinel] downlinked")\n' +
        '\n' +
        'class Orbit:\n' +
        '    def __init__(self, alt): self.alt = alt\n',
    });
    try {
      const embedder = new MockEmbedder();
      const result = await indexRepo({ db, embedder, rootPath: root });
      expect(result.files).toBe(2);
      expect(result.filesIndexed).toBe(2);
      expect(result.filesSkipped).toBe(0);
      expect(result.chunks).toBeGreaterThanOrEqual(3);

      // Every code_chunks row has a matching code_chunks_vec row.
      const chunkCount = (
        db.prepare('SELECT COUNT(*) as c FROM code_chunks').get() as { c: number }
      ).c;
      const vecCount = (
        db.prepare('SELECT COUNT(*) as c FROM code_chunks_vec').get() as { c: number }
      ).c;
      expect(chunkCount).toBe(vecCount);
    } finally {
      rmRoot();
      closeDb();
    }
  });

  it('dispatches symbol + import extraction by language (regression: 0.3.x ignored Python/Go/Java)', async () => {
    // Pre-0.4.0 the pipeline always called the JS-only `extractSymbols` /
    // `extractImports`, so non-JS/TS files chunked (file-level fallback)
    // but produced zero symbol/import rows. `find_symbol("PaymentProcessor")`
    // would return empty for a Python file even though the chunk existed.
    // This test pins the dispatch by asserting at least one symbol and one
    // import row per language.
    const { db, cleanup: closeDb } = await openTestDb();
    const { root, cleanup: rmRoot } = seedRepo({
      'svc/payments.py':
        'from typing import Optional\n\n' +
        'class PaymentProcessor:\n' +
        '    def charge(self, amt: int) -> Optional[str]:\n' +
        '        return "ok"\n',
      'svc/server.go':
        'package svc\n\n' +
        'import "fmt"\n\n' +
        'type Repo struct{}\n\n' +
        'func (r *Repo) Save() { fmt.Println("saved") }\n',
      'svc/Util.java':
        'package svc;\n\n' +
        'import java.util.List;\n\n' +
        'public class Util {\n' +
        '    public static String greet() { return "hi"; }\n' +
        '}\n',
    });
    try {
      const embedder = new MockEmbedder();
      const result = await indexRepo({ db, embedder, rootPath: root });
      expect(result.files).toBe(3);
      expect(result.filesIndexed).toBe(3);
      // Every language should have produced at least one symbol now.
      expect(result.symbols).toBeGreaterThanOrEqual(3);
      expect(result.imports).toBeGreaterThanOrEqual(3);

      const pyRows = db
        .prepare(
          `SELECT s.qualified FROM symbols s
             JOIN code_chunks c ON c.id = s.chunk_id
            WHERE c.file_path = 'svc/payments.py'`,
        )
        .all() as Array<{ qualified: string }>;
      expect(pyRows.map((r) => r.qualified).sort()).toEqual(
        expect.arrayContaining(['PaymentProcessor', 'PaymentProcessor.charge']),
      );

      const goRows = db
        .prepare(
          `SELECT s.qualified FROM symbols s
             JOIN code_chunks c ON c.id = s.chunk_id
            WHERE c.file_path = 'svc/server.go'`,
        )
        .all() as Array<{ qualified: string }>;
      expect(goRows.map((r) => r.qualified)).toEqual(
        expect.arrayContaining(['Repo', 'Repo.Save']),
      );

      const javaRows = db
        .prepare(
          `SELECT s.qualified FROM symbols s
             JOIN code_chunks c ON c.id = s.chunk_id
            WHERE c.file_path = 'svc/Util.java'`,
        )
        .all() as Array<{ qualified: string }>;
      expect(javaRows.map((r) => r.qualified)).toEqual(
        expect.arrayContaining(['Util', 'Util.greet']),
      );

      const importTargets = (
        db
          .prepare('SELECT DISTINCT target_path FROM imports')
          .all() as Array<{ target_path: string }>
      ).map((r) => r.target_path);
      expect(importTargets).toEqual(
        expect.arrayContaining(['pkg:typing', 'pkg:fmt', 'pkg:java.util.List']),
      );
    } finally {
      rmRoot();
      closeDb();
    }
  });

  it('additionalIgnore excludes matching files from the walk', async () => {
    const { db, cleanup: closeDb } = await openTestDb();
    const { root, cleanup: rmRoot } = seedRepo(SAMPLE);
    try {
      const embedder = new MockEmbedder();
      const result = await indexRepo({
        db,
        embedder,
        rootPath: root,
        additionalIgnore: ['src/b.ts'],
      });
      expect(result.files).toBe(2);
      const paths = (
        db
          .prepare('SELECT file_path FROM file_hashes ORDER BY file_path')
          .all() as Array<{ file_path: string }>
      ).map((r) => r.file_path);
      expect(paths).not.toContain('src/b.ts');
    } finally {
      rmRoot();
      closeDb();
    }
  });
});

/**
 * Always-on tests — no tree-sitter involved.
 */
describe('removeFile (pure DB)', () => {
  it('deletes chunks, symbols, imports, vec, and file_hashes for a file', async () => {
    const { db, cleanup: closeDb } = await openTestDb();
    try {
      // Seed one file's worth of rows directly — no pipeline involved.
      const filePath = 'src/seeded.ts';
      const chunkId = 'chunk-seeded-1';
      const contentHash = 'a'.repeat(64);
      db.prepare(
        `INSERT INTO code_chunks (id, file_path, line_start, line_end, content, language, content_hash)
         VALUES (?, ?, 1, 1, 'x', 'typescript', ?)`,
      ).run(chunkId, filePath, contentHash);
      db.prepare(
        `INSERT INTO symbols (node_id, chunk_id, kind, name, qualified)
         VALUES ('node-1', ?, 'function', 'foo', 'foo')`,
      ).run(chunkId);
      db.prepare(
        `INSERT INTO imports (edge_id, src_file, target_path, confidence)
         VALUES ('edge-1', ?, 'pkg:fs', 'EXTRACTED')`,
      ).run(filePath);
      db.prepare(
        `INSERT INTO file_hashes (file_path, sha256, indexed_at) VALUES (?, ?, ?)`,
      ).run(filePath, contentHash, Date.now());
      db.prepare(
        `INSERT INTO code_chunks_vec (chunk_id, embedding) VALUES (?, ?)`,
      ).run(chunkId, vectorToBuffer(new Array(1536).fill(0)));

      removeFile({ db, filePath });

      expect(
        (db.prepare('SELECT COUNT(*) as c FROM code_chunks WHERE file_path = ?').get(
          filePath,
        ) as { c: number }).c,
      ).toBe(0);
      expect(
        (db.prepare('SELECT COUNT(*) as c FROM symbols WHERE chunk_id = ?').get(
          chunkId,
        ) as { c: number }).c,
      ).toBe(0);
      expect(
        (db.prepare('SELECT COUNT(*) as c FROM imports WHERE src_file = ?').get(
          filePath,
        ) as { c: number }).c,
      ).toBe(0);
      expect(
        (db.prepare('SELECT COUNT(*) as c FROM file_hashes WHERE file_path = ?').get(
          filePath,
        ) as { c: number }).c,
      ).toBe(0);
      expect(
        (db.prepare('SELECT COUNT(*) as c FROM code_chunks_vec WHERE chunk_id = ?').get(
          chunkId,
        ) as { c: number }).c,
      ).toBe(0);
    } finally {
      closeDb();
    }
  });

  it('is a no-op on a path with no existing rows', async () => {
    const { db, cleanup: closeDb } = await openTestDb();
    try {
      expect(() => removeFile({ db, filePath: 'src/missing.ts' })).not.toThrow();
    } finally {
      closeDb();
    }
  });
});
