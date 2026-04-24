/**
 * Phase 10 C5 — reingest-unchanged benchmark.
 *
 * What it measures: on a second ingestion of a file set whose contents
 * have NOT changed, what fraction of files hit the ContentCache's hot
 * path (computeKey + get → non-null), and how long does that hot path
 * take?
 *
 * Why it matters: Phase 10 C1/C2's value proposition is that
 * re-ingesting an unchanged repo is near-free. If the hit rate drops
 * below ~99% something is wrong with the key normalization; if the
 * p95 hot-path latency creeps up past ~100ms we've regressed the cache
 * lookup path.
 *
 * ### What this benchmark does
 *
 *   1. Generate N synthetic TS files in a tmp dir. Content varies
 *      across files (distinct hashes) but is DETERMINISTIC — seeded
 *      PRNG — so the benchmark is repeatable.
 *   2. "Seed" pass: call `computeKey` + `put` for every file (cold).
 *   3. "Hot" pass: call `computeKey` + `get` for every file. Record
 *      per-file wall time and whether the result was a hit.
 *   4. Compute p50/p95/p99 over the hot-pass samples, compute hit rate,
 *      print the markdown table, exit non-zero if thresholds missed.
 *
 * ### Wiring
 *
 * The cache talks to:
 *   - A TypeORM Repository — replaced here with a Map-backed fake
 *     matching the pattern in content-cache.service.spec.ts, since we
 *     don't want to require a live Postgres to run benchmarks.
 *   - A BlobStore — real `LocalFsBlobStore` against a tmp dir. This
 *     is the FS path production uses, so the measured read/write
 *     costs are honest.
 *
 * Intentionally NOT used:
 *   - `CacheHashIndexService` (needs Redis) — orthogonal to what we're
 *     measuring. The `has()` index is an optimization layered on top of
 *     the cache itself.
 *   - `IncrementalIngestService` — pulls in Memgraph as a dep.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Repository } from 'typeorm';
import { ContentCacheService } from '../src/cache/content-cache.service';
import { LocalFsBlobStore } from '../src/cache/blob-store';
import { CacheEntry } from '../src/entities/cache-entry.entity';
import { formatTable, measure, summarize } from './_harness';

const FILE_COUNT = 100;
// Fails the benchmark if either threshold is missed on the hot pass.
const MIN_HIT_RATE = 0.99;
const MAX_P95_MS = 100;

/**
 * Deterministic Mulberry32 PRNG. A fixed seed means that re-running
 * the benchmark always generates the exact same file contents — we
 * want noise to come from the system-under-test, not the input.
 */
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

function generateSyntheticFile(rand: () => number, index: number): string {
  // Each file is a small TS module with a handful of exports. Line
  // counts and identifier names vary deterministically.
  const lineCount = 20 + Math.floor(rand() * 30);
  const lines: string[] = [`// synthetic file #${index}`];
  for (let i = 0; i < lineCount; i++) {
    const n = Math.floor(rand() * 1_000_000);
    lines.push(`export const k${index}_${i} = ${n};`);
  }
  lines.push(`export function f${index}() { return ${Math.floor(rand() * 1000)}; }`);
  return lines.join('\n') + '\n';
}

/**
 * Map-backed CacheEntry repo — lifted from the content-cache spec
 * pattern. Minimum surface to satisfy ContentCacheService's usage:
 * findOne / find / save / update / delete / create.
 */
function makeRepo(): Repository<CacheEntry> {
  const rows = new Map<string, CacheEntry>();
  const keyOf = (e: Partial<CacheEntry>) =>
    `${e.cacheKey}::${e.artifactKind}`;

  const repo: any = {
    create: (obj: Partial<CacheEntry>) => ({
      ...obj,
      id: obj.id ?? `id-${rows.size + 1}`,
      createdAt: obj.createdAt ?? new Date(),
      lastAccessedAt: obj.lastAccessedAt ?? new Date(),
    }),
    save: async (entity: CacheEntry) => {
      const stored: CacheEntry = {
        ...entity,
        id: entity.id ?? `id-${rows.size + 1}`,
        createdAt: entity.createdAt ?? new Date(),
        lastAccessedAt: entity.lastAccessedAt ?? new Date(),
        orgId: entity.orgId ?? null,
      } as CacheEntry;
      rows.set(keyOf(stored), stored);
      return stored;
    },
    findOne: async ({ where }: any) => rows.get(keyOf(where)) ?? null,
    find: async ({ where }: any = {}) => {
      const out: CacheEntry[] = [];
      for (const r of rows.values()) {
        if (where?.cacheKey && r.cacheKey !== where.cacheKey) continue;
        if (where?.artifactKind && r.artifactKind !== where.artifactKind) continue;
        out.push(r);
      }
      return out;
    },
    update: async (where: any, patch: any) => {
      for (const [k, r] of rows) {
        if (where.cacheKey && r.cacheKey !== where.cacheKey) continue;
        if (where.artifactKind && r.artifactKind !== where.artifactKind) continue;
        rows.set(k, { ...r, ...patch });
      }
      return { affected: 1 };
    },
    delete: async (where: any) => {
      let n = 0;
      for (const [k, r] of rows) {
        if (where.id && r.id !== where.id) continue;
        if (where.cacheKey && r.cacheKey !== where.cacheKey) continue;
        if (where.artifactKind && r.artifactKind !== where.artifactKind) continue;
        rows.delete(k);
        n += 1;
      }
      return { affected: n };
    },
  };
  return repo as Repository<CacheEntry>;
}

async function main(): Promise<void> {
  // Isolated tmp dirs for sources + blob store.
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-reingest-src-'));
  const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-reingest-blob-'));

  try {
    // 1. Generate the synthetic file set.
    const rand = mulberry32(0xc0de01);
    const files: Array<{ relPath: string; content: string }> = [];
    for (let i = 0; i < FILE_COUNT; i++) {
      const relPath = `src/module${Math.floor(i / 10)}/file${i}.ts`;
      const content = generateSyntheticFile(rand, i);
      const abs = path.join(srcDir, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      files.push({ relPath, content });
    }

    // 2. Build the ContentCacheService.
    const repo = makeRepo();
    const blobStore = new LocalFsBlobStore(blobDir);
    const svc = new ContentCacheService(repo, blobStore);

    // 3. Seed pass — cold. We don't time this; it's setup.
    for (const f of files) {
      const key = svc.computeKey(f.content);
      await svc.put(key, 'symbols', {
        filePath: f.relPath,
        nodeIds: [`n:${key.slice(0, 8)}`],
      });
    }

    // 4. Hot pass — the actual measurement.
    const samples: number[] = [];
    let hits = 0;
    for (const f of files) {
      const { result, ms } = await measure(async () => {
        const key = svc.computeKey(f.content);
        const cached = await svc.get(key, 'symbols');
        return cached != null;
      });
      samples.push(ms);
      if (result) hits += 1;
    }

    // 5. Report.
    const stats = summarize(samples);
    const hitRate = hits / files.length;

    const headers = ['scenario', 'files', 'p50 ms', 'p95 ms', 'p99 ms', 'hit_rate'];
    const rows = [
      [
        'reingest_unchanged',
        String(files.length),
        stats.p50.toFixed(2),
        stats.p95.toFixed(2),
        stats.p99.toFixed(2),
        `${(hitRate * 100).toFixed(1)}%`,
      ],
    ];

    console.log('');
    console.log(formatTable(headers, rows));
    console.log('');
    console.log(
      `mean=${stats.mean.toFixed(2)}ms  min=${stats.min.toFixed(2)}ms  max=${stats.max.toFixed(2)}ms  hits=${hits}/${files.length}`,
    );
    console.log('');

    // Threshold gate.
    const failures: string[] = [];
    if (hitRate < MIN_HIT_RATE) {
      failures.push(
        `hit_rate ${(hitRate * 100).toFixed(1)}% < ${(MIN_HIT_RATE * 100).toFixed(0)}%`,
      );
    }
    if (stats.p95 > MAX_P95_MS) {
      failures.push(`p95 ${stats.p95.toFixed(2)}ms > ${MAX_P95_MS}ms`);
    }
    if (failures.length) {
      console.error(`FAIL: ${failures.join('; ')}`);
      process.exitCode = 1;
      return;
    }
    console.log('PASS');
  } finally {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(blobDir, { recursive: true, force: true });
  }
}

// Top-level await is off; use a plain then-chain so ts-node exits with
// the right code.
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
