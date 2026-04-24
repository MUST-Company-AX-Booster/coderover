/**
 * Phase 11 Wave 3 L15 — query p95 latency benchmark.
 *
 * Target: p95 ≤200ms for each of the three user-facing local-mode
 * query paths:
 *
 *   - `search_code`        — KNN over `code_chunks_vec`.
 *   - `find_symbol`        — name-match over `symbols` joined with chunks.
 *   - `find_dependencies`  — upstream/downstream edges from `imports`.
 *
 * Wave 3 L12–L14 (sibling agent) owns the query implementations. The
 * source files are at `src/local/query/{search-code,find-symbol,find-dependencies}.ts`.
 * At bench-authoring time those files may or may not be committed yet;
 * the script probes via `require.resolve` and cleanly skips with a
 * warning if any are missing — no crash.
 *
 * Query signatures (from `test/local/query/*.spec.ts`):
 *   - `searchCode(query: string, { db, embedder, limit? }): Promise<{...}>`
 *   - `findSymbol(name: string, { db }): { symbolName, results, totalFound }`
 *   - `findDependencies(target: string, { db }): { target, upstream, downstream }`
 *
 * Query mix:
 *   - 100 search_code calls: half real corpus tokens (hits), half
 *     PRNG-derived misses (long tail).
 *   - 100 find_symbol calls: synthesized class + method names.
 *   - 100 find_dependencies calls: synthesized relative file paths.
 *
 * Output: markdown table with p50/p95/p99 per scenario; exit 1 if
 * any scenario's p95 > 200ms.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type Database from 'better-sqlite3';

import { MockEmbedder } from '../src/local/embed/embedder';

import { formatTable, measure, percentile } from './_harness';
import { indexCorpus } from './index-10k.bench';
import { synthesizeRepo } from './synthesize';

/** Threshold from Phase 11 plan §3. */
const MAX_P95_MS = 200;
const QUERIES_PER_SCENARIO = 100;
const EMBED_DIM = 1536;

interface QueryApi {
  searchCode: (
    query: string,
    opts: { db: Database.Database; embedder: MockEmbedder; limit?: number },
  ) => Promise<unknown>;
  findSymbol: (
    name: string,
    opts: { db: Database.Database },
  ) => unknown;
  findDependencies: (
    target: string,
    opts: { db: Database.Database },
  ) => unknown;
}

/**
 * Resolve the three query modules defensively. If ANY of them is
 * missing we return `null` and the benchmark skips. Using `require`
 * (not `import`) keeps this runtime-conditional — a missing module
 * doesn't fail the TypeScript build at the call site.
 */
function loadQueryApi(): QueryApi | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tryReq = (p: string): any => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      return require(p);
    } catch {
      return null;
    }
  };

  const searchMod = tryReq('../src/local/query/search-code');
  const symbolMod = tryReq('../src/local/query/find-symbol');
  const depsMod = tryReq('../src/local/query/find-dependencies');
  if (!searchMod || !symbolMod || !depsMod) return null;

  const searchCode = searchMod.searchCode ?? searchMod.default;
  const findSymbol = symbolMod.findSymbol ?? symbolMod.default;
  const findDependencies = depsMod.findDependencies ?? depsMod.default;
  if (
    typeof searchCode !== 'function' ||
    typeof findSymbol !== 'function' ||
    typeof findDependencies !== 'function'
  ) {
    return null;
  }
  return { searchCode, findSymbol, findDependencies };
}

/** Mulberry32 — reproducible query-token generator. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main(): Promise<void> {
  const api = loadQueryApi();
  if (!api) {
    console.warn('[bench] queries not yet available, skipping');
    return;
  }

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-query-repo-'));
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-query-db-'));
  const dbPath = path.join(dbDir, 'local.db');

  try {
    // 1. Synthesize + index (reuse index-10k's helper).
    synthesizeRepo({
      rootDir,
      fileCount: 200,
      avgLinesPerFile: 50,
      seed: 0x2000,
    });
    const embedder = new MockEmbedder(EMBED_DIM);
    const indexed = await indexCorpus({ rootDir, dbPath, embedder });

    // 2. Build the query pool (deterministic).
    const rand = mulberry32(0xabcd);

    // `search_code`: alternate real corpus tokens with PRNG misses.
    const realTokens = [
      'serialize',
      'validate',
      'build',
      'fetch',
      'dispatch',
      'session',
      'payload',
      'cache',
      'digest',
      'manifest',
    ];
    const searchQueries: string[] = [];
    for (let i = 0; i < QUERIES_PER_SCENARIO; i++) {
      if (i % 2 === 0) {
        searchQueries.push(realTokens[i % realTokens.length]);
      } else {
        searchQueries.push(
          `unlikely_token_${Math.floor(rand() * 1_000_000).toString(16)}`,
        );
      }
    }

    // `find_symbol`: mix class names + method names that exist in the corpus.
    const symbolNames: string[] = [];
    for (let i = 0; i < QUERIES_PER_SCENARIO; i++) {
      const idx = Math.floor(rand() * indexed.filesIndexed);
      symbolNames.push(i % 2 === 0 ? `Service${idx}` : 'fetchRecord0');
    }

    // `find_dependencies`: synthesized relative paths.
    const srcFiles: string[] = [];
    for (let i = 0; i < QUERIES_PER_SCENARIO; i++) {
      const idx = Math.floor(rand() * indexed.filesIndexed);
      srcFiles.push(`src/services/service-${idx}.ts`);
    }

    // 3. Run each scenario.
    const searchSamples: number[] = [];
    for (const q of searchQueries) {
      const { ms } = await measure(() =>
        api.searchCode(q, { db: indexed.db, embedder, limit: 10 }),
      );
      searchSamples.push(ms);
    }

    const symbolSamples: number[] = [];
    for (const n of symbolNames) {
      const { ms } = await measure(() => api.findSymbol(n, { db: indexed.db }));
      symbolSamples.push(ms);
    }

    const depSamples: number[] = [];
    for (const f of srcFiles) {
      const { ms } = await measure(() =>
        api.findDependencies(f, { db: indexed.db }),
      );
      depSamples.push(ms);
    }

    indexed.db.close();

    // 4. Report.
    const headers = ['scenario', 'count', 'p50 ms', 'p95 ms', 'p99 ms'];
    const rows: Array<Array<string | number>> = [
      row('search_code', searchSamples),
      row('find_symbol', symbolSamples),
      row('find_dependencies', depSamples),
    ];

    console.log('');
    console.log(formatTable(headers, rows));
    console.log('');

    const failures: string[] = [];
    for (const r of rows) {
      const p95 = Number(r[3]);
      if (Number.isFinite(p95) && p95 > MAX_P95_MS) {
        failures.push(`${r[0]} p95 ${p95.toFixed(2)}ms > ${MAX_P95_MS}ms`);
      }
    }
    if (failures.length) {
      console.error(`FAIL: ${failures.join('; ')}`);
      process.exitCode = 1;
      return;
    }
    console.log('PASS');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
}

function row(label: string, samples: number[]): Array<string | number> {
  return [
    label,
    String(samples.length),
    percentile(samples, 50).toFixed(2),
    percentile(samples, 95).toFixed(2),
    percentile(samples, 99).toFixed(2),
  ];
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
