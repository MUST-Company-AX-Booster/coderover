/**
 * Phase 11 Wave 3 L15 — incremental reingest benchmark.
 *
 * Target: p95 ≤2000ms for a 1-file re-index on a 10k-LOC corpus.
 * Phase 11 plan §3 "Performance Targets".
 *
 * Scenario:
 *   1. Synthesize + index a 10k-LOC corpus (reuse `indexCorpus`).
 *   2. Pick 20 files at random.
 *   3. For each picked file:
 *      a. Mutate one line on disk (append a trailing comment).
 *      b. Read + hash the file; compare to `file_hashes.sha256`.
 *         Hash unchanged → skip (counts as a skipped sample).
 *         Hash changed   → re-run chunker/symbol/import pipeline for
 *                           just that file, delete stale rows, insert
 *                           fresh ones, update `file_hashes`.
 *      c. Record per-file wall time.
 *
 * Output: p50/p95/max + skip-rate markdown, exit 1 if p95 > 2000ms.
 * The skip-rate should be 0% on this bench since we mutate every file
 * we measure; surfacing it anyway guards against a regression where
 * hashes stop actually detecting mutations.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { parseFile } from '../src/local/ingest/grammar-loader';
import { detectLanguage } from '../src/local/ingest/language-detect';
import { chunkFile } from '../src/local/ingest/chunker';
import { extractSymbols } from '../src/local/ingest/symbol-extractor';
import { extractImports } from '../src/local/ingest/import-extractor';

import { MockEmbedder } from '../src/local/embed/embedder';

import { formatTable, measure, percentile } from './_harness';
import { indexCorpus, vectorToBuffer } from './index-10k.bench';
import { synthesizeRepo } from './synthesize';

/** Threshold from Phase 11 plan §3. */
const MAX_P95_MS = 2000;
const FILES_TO_MUTATE = 20;
const EMBED_DIM = 1536;

function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Mulberry32 — reproducible file-selection PRNG. */
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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-reingest1-repo-'));
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-reingest1-db-'));
  const dbPath = path.join(dbDir, 'local.db');

  try {
    // 1. Synthesize + initial index.
    const synth = synthesizeRepo({
      rootDir,
      fileCount: 200,
      avgLinesPerFile: 50,
      seed: 0x3000,
    });
    const embedder = new MockEmbedder(EMBED_DIM);
    const indexed = await indexCorpus({ rootDir, dbPath, embedder });
    const db = indexed.db;

    // 2. Prepared statements for the incremental path.
    const selHash = db.prepare(
      `SELECT sha256 FROM file_hashes WHERE file_path = ?`,
    );
    const delChunks = db.prepare(
      `DELETE FROM code_chunks WHERE file_path = ?`,
    );
    const delVecByChunks = db.prepare(
      `DELETE FROM code_chunks_vec WHERE chunk_id IN (SELECT id FROM code_chunks WHERE file_path = ?)`,
    );
    const delSymbols = db.prepare(
      `DELETE FROM symbols WHERE chunk_id IN (SELECT id FROM code_chunks WHERE file_path = ?)`,
    );
    const delImports = db.prepare(
      `DELETE FROM imports WHERE src_file = ?`,
    );
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

    // 3. Pick N distinct files to mutate.
    const rand = mulberry32(0xfeed);
    const picked: string[] = [];
    const pickedSet = new Set<string>();
    while (picked.length < FILES_TO_MUTATE && picked.length < synth.files.length) {
      const idx = Math.floor(rand() * synth.files.length);
      const abs = synth.files[idx];
      if (pickedSet.has(abs)) continue;
      pickedSet.add(abs);
      picked.push(abs);
    }

    // 4. Mutate + reingest each.
    const samples: number[] = [];
    let skipped = 0;
    for (const abs of picked) {
      // Mutate: append a unique-per-file trailing line. Single write,
      // single byte range changed — matches what an editor save would
      // produce.
      const relPath = path.relative(rootDir, abs).split(path.sep).join('/');
      const original = fs.readFileSync(abs, 'utf8');
      const mutated = `${original}// bench-mutation-${Date.now()}-${Math.floor(rand() * 1e9)}\n`;
      fs.writeFileSync(abs, mutated, 'utf8');

      const { ms } = await measure(async () => {
        // Gate 1: hash check. If unchanged, skip the heavy work.
        const newContent = fs.readFileSync(abs, 'utf8');
        const newHash = sha256Hex(newContent);
        const prior = selHash.get(relPath) as { sha256: string } | undefined;
        if (prior && prior.sha256 === newHash) {
          skipped++;
          return;
        }

        // Gate 2: re-parse + re-extract.
        const language = detectLanguage(abs);
        if (!language) {
          throw new Error(`unsupported language for ${abs}`);
        }
        const tree = parseFile(newContent, language);
        const chunks = chunkFile({
          filePath: relPath,
          content: newContent,
          language,
          tree,
        });
        const symbols = extractSymbols({ filePath: relPath, chunks, tree });
        const imports = extractImports({
          filePath: relPath,
          absolutePath: abs,
          repoRoot: rootDir,
          tree,
          language,
        });

        const embedResp = await embedder.embed({
          input: chunks.map((c) => c.content),
        });

        // Gate 3: apply delta atomically. Symbols/vecs are keyed by
        // chunk_id, and chunks by file_path, so order matters: delete
        // symbols + vecs FIRST (they reference the old chunk rows),
        // then delete the old chunks. Imports stand alone.
        const apply = db.transaction(() => {
          delSymbols.run(relPath);
          delVecByChunks.run(relPath);
          delChunks.run(relPath);
          delImports.run(relPath);
          for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            insertChunk.run(
              c.chunkId,
              c.filePath,
              c.lineStart,
              c.lineEnd,
              c.content,
              c.language,
              newHash,
            );
            insertVec.run(c.chunkId, vectorToBuffer(embedResp.vectors[i]));
          }
          for (const s of symbols) {
            insertSymbol.run(s.nodeId, s.chunkId, s.kind, s.name, s.qualified);
          }
          for (const imp of imports) {
            insertImport.run(imp.edgeId, imp.srcFile, imp.targetPath, imp.confidence);
          }
          insertFileHash.run(relPath, newHash, Date.now());
        });
        apply();
      });

      samples.push(ms);
    }

    db.close();

    // 5. Report.
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    const max = samples.length ? Math.max(...samples) : NaN;
    const skipRate = skipped / Math.max(1, samples.length);

    const headers = ['scenario', 'count', 'p50 ms', 'p95 ms', 'max ms', 'skip_rate'];
    const rows: Array<Array<string | number>> = [
      [
        'reingest_1_file',
        String(samples.length),
        p50.toFixed(2),
        p95.toFixed(2),
        max.toFixed(2),
        `${(skipRate * 100).toFixed(1)}%`,
      ],
    ];

    console.log('');
    console.log(formatTable(headers, rows));
    console.log('');
    console.log(
      `skipped=${skipped}/${samples.length}  threshold_p95=${MAX_P95_MS}ms`,
    );
    console.log('');

    const failures: string[] = [];
    if (p95 > MAX_P95_MS) {
      failures.push(`p95 ${p95.toFixed(2)}ms > ${MAX_P95_MS}ms`);
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

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
