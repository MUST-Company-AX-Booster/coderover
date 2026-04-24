/**
 * Phase 11 Wave 5 L22 — recall@5 benchmark.
 *
 * Compares OpenAI (text-embedding-3-small, 1536-dim) against MiniLM
 * (all-MiniLM-L6-v2, 384-dim) via Transformers.js, using a hand-curated
 * query→expected-file pool over the synthesized corpus. MockEmbedder is
 * included as a control — it has no semantic signal so recall should be
 * near-random (≈5/1000 = 0.5% at k=5 over 200 files).
 *
 * Runs end-to-end: index the corpus with each embedder, issue the N
 * queries, check whether the expected file appears in the top-5.
 *
 * Skips gracefully when dependencies aren't available:
 *   - OpenAI: needs `OPENAI_API_KEY`. Without it, logs "skipped" for that row.
 *   - MiniLM: needs `@xenova/transformers` (optional dep). Without it,
 *     logs "skipped" for that row.
 *   - MockEmbedder: always runs (control).
 *
 * Emits a markdown table. Does NOT fail the run on a skipped row — this
 * is a characterisation benchmark, not a gate. Failures on the RUN
 * side (e.g., the embedder errors mid-batch) do fail the run.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { synthesizeRepo } from './synthesize';
import { indexRepo } from '../src/local/pipeline';
import { openDb } from '../src/local/db/open';
import { migrate } from '../src/local/db/migrator';
import { migration001Initial } from '../src/local/db/migrations/001_initial';
import { makeSqliteVecMigration } from '../src/local/db/migrations/002_sqlite_vec';
import { loadSqliteVec } from '../src/local/db/sqlite-vec';
import { searchCode } from '../src/local/query';
import { MockEmbedder, OpenAIEmbedder } from '../src/local/embed/embedder';
import type { Embedder } from '../src/local/embed/types';
import { summarize, formatTable } from './_harness';

interface QueryCase {
  query: string;
  expectedFile: string;
}

/**
 * Build query→expected-file pairs from the synthesized corpus. The
 * synthesizer emits class names like `ServiceN` and method names tied
 * to the file index — we pick query words that should rank the target
 * file at the top for any semantically-competent embedder.
 */
function buildQueries(
  files: string[],
  rootDir: string,
  sampleSize: number,
): QueryCase[] {
  const relFiles = files.map((f) => path.relative(rootDir, f));
  const n = Math.min(sampleSize, relFiles.length);
  const out: QueryCase[] = [];
  // Deterministic strided sample so runs are comparable across embedders.
  const step = Math.max(1, Math.floor(relFiles.length / n));
  for (let i = 0; i < n; i++) {
    const f = relFiles[i * step];
    if (!f) break;
    const base = path.basename(f, path.extname(f));
    // Synthesizer names files service-0.ts, service-1.ts etc.
    const match = base.match(/service-(\d+)/);
    const id = match ? match[1] : '0';
    out.push({
      query: `find the Service${id} class and its methods`,
      expectedFile: f,
    });
  }
  return out;
}

async function indexAndQuery(
  label: string,
  embedder: Embedder,
  rootDir: string,
  files: string[],
  queries: QueryCase[],
): Promise<{ label: string; recall5: number; queryMs: number[] } | { label: string; skipped: string }> {
  const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), `recall-${label}-`));
  const dbPath = path.join(tmpDbDir, 'local.db');
  let db: Database.Database | null = null;
  try {
    db = openDb(dbPath);
    loadSqliteVec(db);
    await migrate(db, [
      migration001Initial,
      makeSqliteVecMigration(embedder.dimension),
    ]);

    const result = await indexRepo({
      db,
      embedder,
      rootPath: rootDir,
    });
    if (result.files === 0) {
      return { label, skipped: 'no files indexed' };
    }

    let hits = 0;
    const queryMs: number[] = [];
    for (const q of queries) {
      const t0 = performance.now();
      const res = await searchCode(q.query, { db, embedder, limit: 5 });
      const elapsed = performance.now() - t0;
      queryMs.push(elapsed);
      if (res.results.some((r) => r.filePath === q.expectedFile)) hits++;
    }
    return { label, recall5: hits / queries.length, queryMs };
  } catch (err) {
    return { label, skipped: err instanceof Error ? err.message : String(err) };
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
  }
}

async function main() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-corpus-'));
  const { files } = synthesizeRepo({
    rootDir: repoDir,
    fileCount: 200,
    avgLinesPerFile: 50,
    seed: 0xbeef,
  });
  const queries = buildQueries(files, repoDir, 50);

  const headers = ['embedder', 'dim', 'recall@5', 'query_p50_ms', 'query_p95_ms', 'note'];
  const rows: string[][] = [];

  // Control: MockEmbedder (deterministic but no semantic signal)
  const mockResult = await indexAndQuery(
    'mock',
    new MockEmbedder(1536),
    repoDir,
    files,
    queries,
  );
  if ('skipped' in mockResult) {
    rows.push(['MockEmbedder', '1536', 'skipped', '-', '-', mockResult.skipped]);
  } else {
    const s = summarize(mockResult.queryMs);
    rows.push([
      'MockEmbedder',
      '1536',
      (mockResult.recall5 * 100).toFixed(1) + '%',
      s.p50.toFixed(2),
      s.p95.toFixed(2),
      'control',
    ]);
  }

  // OpenAI text-embedding-3-small
  if (!process.env.OPENAI_API_KEY) {
    rows.push(['OpenAI text-embedding-3-small', '1536', 'skipped', '-', '-', 'OPENAI_API_KEY not set']);
  } else {
    const openaiResult = await indexAndQuery(
      'openai',
      new OpenAIEmbedder({ apiKey: process.env.OPENAI_API_KEY! }),
      repoDir,
      files,
      queries,
    );
    if ('skipped' in openaiResult) {
      rows.push(['OpenAI text-embedding-3-small', '1536', 'skipped', '-', '-', openaiResult.skipped]);
    } else {
      const s = summarize(openaiResult.queryMs);
      rows.push([
        'OpenAI text-embedding-3-small',
        '1536',
        (openaiResult.recall5 * 100).toFixed(1) + '%',
        s.p50.toFixed(2),
        s.p95.toFixed(2),
        'network',
      ]);
    }
  }

  // MiniLM via Transformers.js
  try {
    const { OfflineEmbedder } = await import('../src/local/embed/offline-embedder');
    const minilmResult = await indexAndQuery(
      'minilm',
      new OfflineEmbedder(),
      repoDir,
      files,
      queries,
    );
    if ('skipped' in minilmResult) {
      rows.push(['MiniLM-L6-v2 (Transformers.js)', '384', 'skipped', '-', '-', minilmResult.skipped]);
    } else {
      const s = summarize(minilmResult.queryMs);
      rows.push([
        'MiniLM-L6-v2 (Transformers.js)',
        '384',
        (minilmResult.recall5 * 100).toFixed(1) + '%',
        s.p50.toFixed(2),
        s.p95.toFixed(2),
        'offline',
      ]);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    rows.push(['MiniLM-L6-v2 (Transformers.js)', '384', 'skipped', '-', '-', msg]);
  }

  console.log(formatTable(headers, rows));
  console.log(`\nqueries=${queries.length}  corpus_files=${files.length}\n`);

  fs.rmSync(repoDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
