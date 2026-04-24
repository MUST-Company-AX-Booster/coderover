/**
 * Phase 11 Wave 3 L15 — initial-index benchmark (10k LOC target).
 *
 * Target: index 10,000 LOC (≈200 files × 50 lines) in ≤60s wall time
 * on the reference dev laptop. Phase 11 plan §3 "Performance Targets".
 *
 * Pipeline measured end-to-end:
 *
 *   synthesize → open SQLite → migrate → walk → chunk → extract
 *   symbols → extract imports → batch-embed (MockEmbedder) →
 *   bulk-insert chunks/symbols/imports/embeddings/file_hashes.
 *
 * Output: a markdown table with |scenario|files|chunks|symbols|imports|
 * wall_time_s| and a PASS/FAIL line. Exit code 1 if wall_time_s > 60.
 *
 * Export `indexCorpus` so sibling benchmarks
 * (`query-p95.bench.ts`, `reingest-1-file.bench.ts`) don't reimplement
 * the pipeline. The helper is intentionally sequential and uses a
 * single DB transaction per file — this matches what the real ingest
 * daemon does and keeps the numbers honest.
 *
 * MockEmbedder is wired so the benchmark does NOT hit OpenAI. Embed
 * cost is therefore CPU-bound SHA-256 hashing, which is representative
 * of the SQLite-write phase but understates a real OpenAI-bound run.
 * The 60s target is for the pipeline-excluding-network path; callers
 * who want to measure the OpenAI path should swap the embedder.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import Database from 'better-sqlite3';

import { openDb } from '../src/local/db/open';
import { migrate } from '../src/local/db/migrator';
import { migration001Initial } from '../src/local/db/migrations/001_initial';
import { migration002SqliteVec } from '../src/local/db/migrations/002_sqlite_vec';
import { loadSqliteVec } from '../src/local/db/sqlite-vec';

import { walkRepo } from '../src/local/ingest/tree-sitter-walker';
import { chunkFile, type Chunk } from '../src/local/ingest/chunker';
import { extractSymbols, type ExtractedSymbol } from '../src/local/ingest/symbol-extractor';
import { extractImports, type ExtractedImport } from '../src/local/ingest/import-extractor';

import { MockEmbedder } from '../src/local/embed/embedder';
import type { Embedder } from '../src/local/embed/types';

import { formatTable, measure } from './_harness';
import { synthesizeRepo, type SynthesisResult } from './synthesize';

/** Threshold from Phase 11 plan §3. */
const MAX_WALL_SECONDS = 60;

/** Mock embedder dimension — tests run faster at 1536 than CI-sized alts. */
const EMBED_DIM = 1536;

export interface IndexCorpusOptions {
  /** Absolute path to the synthesized repo root. */
  rootDir: string;
  /** Absolute path to an empty directory for the SQLite file. */
  dbPath: string;
  /** Embedder to use — default `MockEmbedder` (no network). */
  embedder?: Embedder;
}

export interface IndexCorpusResult {
  db: Database.Database;
  filesIndexed: number;
  chunks: number;
  symbols: number;
  imports: number;
  wallMs: number;
}

/**
 * Open a fresh SQLite DB, run the two Wave-1 migrations, and ingest every
 * source file under `rootDir` into the local-mode schema. Returns the
 * live DB handle + row counts so callers can either continue using the
 * DB (query benchmark) or close it (indexing-only benchmark).
 *
 * Intentionally sequential: each file is one transaction. Attempting to
 * batch multiple files into a single transaction made the worst-case
 * recovery story worse without improving p50, so we match production.
 */
export async function indexCorpus(opts: IndexCorpusOptions): Promise<IndexCorpusResult> {
  const embedder = opts.embedder ?? new MockEmbedder(EMBED_DIM);

  // 1. Open + migrate.
  const db = openDb(opts.dbPath);
  await migrate(db, [migration001Initial, migration002SqliteVec]);
  // Migration 002 loads sqlite-vec, but better-sqlite3 requires the
  // extension to be re-loaded per-connection. Our openDb returns one
  // connection so this is a no-op if migration just ran, but keep it
  // explicit for reuse scenarios.
  loadSqliteVec(db);

  // 2. Prepared statements — compiled once, reused per file.
  const insertChunk = db.prepare(
    `INSERT OR REPLACE INTO code_chunks
       (id, file_path, line_start, line_end, content, language, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSymbol = db.prepare(
    `INSERT OR REPLACE INTO symbols (node_id, chunk_id, kind, name, qualified)
       VALUES (?, ?, ?, ?, ?)`,
  );
  const insertImport = db.prepare(
    `INSERT OR REPLACE INTO imports (edge_id, src_file, target_path, confidence)
       VALUES (?, ?, ?, ?)`,
  );
  const insertFileHash = db.prepare(
    `INSERT OR REPLACE INTO file_hashes (file_path, sha256, indexed_at)
       VALUES (?, ?, ?)`,
  );
  const insertVec = db.prepare(
    `INSERT OR REPLACE INTO code_chunks_vec (chunk_id, embedding) VALUES (?, ?)`,
  );

  // 3. Walk + pipeline.
  let filesIndexed = 0;
  let chunkTotal = 0;
  let symbolTotal = 0;
  let importTotal = 0;

  const { ms: wallMs } = await measure(async () => {
    for await (const walked of walkRepo(opts.rootDir)) {
      const chunks = chunkFile({
        filePath: walked.relativePath,
        content: walked.content,
        language: walked.language,
        tree: walked.tree,
      });

      const symbols = extractSymbols({
        filePath: walked.relativePath,
        chunks,
        tree: walked.tree,
      });

      const imports = extractImports({
        filePath: walked.relativePath,
        absolutePath: walked.absolutePath,
        repoRoot: opts.rootDir,
        tree: walked.tree,
        language: walked.language,
      });

      // Embed all chunks in this file as one batch — `MockEmbedder` is
      // CPU-bound so batching doesn't matter for it, but a real
      // `OpenAIEmbedder` would see one request per file here.
      const embedResp = await embedder.embed({
        input: chunks.map((c) => c.content),
      });
      if (embedResp.vectors.length !== chunks.length) {
        throw new Error(
          `embedder returned ${embedResp.vectors.length} vectors for ${chunks.length} chunks in ${walked.relativePath}`,
        );
      }

      // One transaction per file — keep the write path isomorphic with
      // the real ingest daemon's per-file commit.
      const applyFile = db.transaction(() => {
        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i];
          insertChunk.run(
            c.chunkId,
            c.filePath,
            c.lineStart,
            c.lineEnd,
            c.content,
            c.language,
            walked.contentHash,
          );
          insertVec.run(c.chunkId, vectorToBuffer(embedResp.vectors[i]));
        }
        for (const s of symbols) {
          insertSymbol.run(s.nodeId, s.chunkId, s.kind, s.name, s.qualified);
        }
        for (const imp of imports) {
          insertImport.run(imp.edgeId, imp.srcFile, imp.targetPath, imp.confidence);
        }
        insertFileHash.run(walked.relativePath, walked.contentHash, Date.now());
      });
      applyFile();

      filesIndexed++;
      chunkTotal += chunks.length;
      symbolTotal += symbols.length;
      importTotal += imports.length;
    }
  });

  return {
    db,
    filesIndexed,
    chunks: chunkTotal,
    symbols: symbolTotal,
    imports: importTotal,
    wallMs,
  };
}

/**
 * `sqlite-vec` stores embeddings as raw little-endian float32 blobs in
 * the `vec0` virtual table. `Float32Array` is already LE on every
 * platform Node supports, so we just view its backing buffer.
 */
export function vectorToBuffer(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

async function main(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-index10k-repo-'));
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-index10k-db-'));
  const dbPath = path.join(dbDir, 'local.db');

  try {
    // 1. Synthesize.
    const synth: SynthesisResult = synthesizeRepo({
      rootDir,
      fileCount: 200,
      avgLinesPerFile: 50,
      seed: 0x1000,
    });

    // 2. Index.
    const result = await indexCorpus({ rootDir, dbPath });
    result.db.close();

    // 3. Report.
    const wallSec = result.wallMs / 1000;
    const headers = [
      'scenario',
      'files',
      'chunks',
      'symbols',
      'imports',
      'wall_time_s',
    ];
    const rows: Array<Array<string | number>> = [
      [
        'index_10k_loc',
        String(result.filesIndexed),
        String(result.chunks),
        String(result.symbols),
        String(result.imports),
        wallSec.toFixed(2),
      ],
    ];

    console.log('');
    console.log(formatTable(headers, rows));
    console.log('');
    console.log(
      `total_loc=${synth.totalLines} seeded_files=${synth.files.length}  threshold=${MAX_WALL_SECONDS}s`,
    );
    console.log('');

    if (wallSec > MAX_WALL_SECONDS) {
      console.error(
        `FAIL: wall_time_s ${wallSec.toFixed(2)} > ${MAX_WALL_SECONDS}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log('PASS');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
}

// Only run when invoked as a script; importing the module (for the
// helper) must not trigger a full benchmark run.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// Re-export types consumed by sibling benchmarks.
export type { Chunk, ExtractedSymbol, ExtractedImport };
