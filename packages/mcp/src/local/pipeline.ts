/**
 * Phase 11 Wave 4 — L16: reusable ingest pipeline.
 *
 * The pipeline is the single entry point for "turn this source file (or
 * this whole repo) into DB rows". It exists so the three callers —
 *
 *   1. `coderover index` CLI (this wave, L17) — index the whole repo.
 *   2. `coderover watch` CLI / daemon (this wave, L16) — index one file
 *      per filesystem event.
 *   3. The benchmark harness (`benchmarks/index-10k.bench.ts`) — a
 *      numbers-focused driver left untouched this wave.
 *
 * — all go through the same walker → chunker → symbol-extractor →
 * import-extractor → embedder → bulk-insert sequence. Diverging paths
 * would be easy to write (every caller has slightly different needs)
 * but would also make "does reingest-in-watch produce the same rows as
 * full-repo-index?" an open question. Sharing one implementation closes
 * that question at compile time.
 *
 * ### Hash-diff gate
 *
 * `indexFile` consults `file_hashes.sha256`. If the content hash matches
 * the stored one, we early-return `{ skipped: true }` — no AST, no
 * embedding, no DB writes. On a change we first cascade-delete the
 * file's existing rows (chunks, symbols, imports, vec) and then insert
 * the fresh ones in one transaction. This is the same contract the
 * backend's `IncrementalIngestService` (Phase 10 C2) uses — the whole
 * "rename-preserves-edges" story depends on it.
 *
 * ### Transaction shape
 *
 * One transaction per file. Large repos with tens of thousands of files
 * would benefit from batching, but batching introduces a much harder
 * recovery story (what's on disk after a partial batch?) and the
 * bench numbers in Wave 3 showed per-file commits already meet the
 * 60s target for 10k LOC. We stay sequential.
 *
 * ### Error recovery
 *
 * Embedder failures propagate up-stack. The watch daemon catches them
 * in its event handler; the CLI logs and continues. Partial DB writes
 * are impossible because the embed call happens before the transaction
 * opens. See `types.ts` in `embed/` for the fail-loud contract.
 *
 * ### Imports never deleted on skip
 *
 * An unchanged file whose hash matches already has the correct rows in
 * the DB; `{ skipped: true }` is load-bearing. Callers that want to
 * force a reindex should clear `file_hashes` or use the `reindex` CLI
 * command (wipes the DB file).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type Database from 'better-sqlite3';

import { walkRepo } from './ingest/tree-sitter-walker';
import { chunkFile, type Chunk } from './ingest/chunker';
import { extractSymbols, type ExtractedSymbol } from './ingest/symbol-extractor';
import { extractPythonSymbols, extractPythonImports } from './ingest/python-extractor';
import { extractGoSymbols, extractGoImports } from './ingest/go-extractor';
import { extractJavaSymbols, extractJavaImports } from './ingest/java-extractor';
import {
  extractImports,
  type ExtractedImport,
} from './ingest/import-extractor';
import { extractJsCalls, type ExtractedCall } from './ingest/call-extractor';
import { parseFile } from './ingest/grammar-loader';
import {
  detectLanguage,
  type SupportedLanguage,
} from './ingest/language-detect';
import type { Embedder } from './embed/types';

/**
 * Dispatch symbol extraction to the language-specific extractor.
 *
 * Wave 4 added the Python / Go / Java extractors as standalone modules
 * but the pipeline kept calling the JS-only `extractSymbols` for every
 * language — Python files would chunk (file-level fallback) but produce
 * zero symbol rows, which made `find_symbol` return empty for any
 * non-JS/TS code in the repo. This dispatcher closes that gap.
 */
function extractSymbolsForLanguage(args: {
  language: SupportedLanguage;
  filePath: string;
  chunks: Chunk[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tree: any;
}): ExtractedSymbol[] {
  switch (args.language) {
    case 'javascript':
    case 'typescript':
      return extractSymbols({
        filePath: args.filePath,
        chunks: args.chunks,
        tree: args.tree,
      });
    case 'python':
      return extractPythonSymbols({
        filePath: args.filePath,
        chunks: args.chunks,
        tree: args.tree,
      });
    case 'go':
      return extractGoSymbols({
        filePath: args.filePath,
        chunks: args.chunks,
        tree: args.tree,
      });
    case 'java':
      return extractJavaSymbols({
        filePath: args.filePath,
        chunks: args.chunks,
        tree: args.tree,
      });
    default: {
      // exhaustive guard — every member of `SupportedLanguage` should
      // have a branch above.
      const _exhaustive: never = args.language;
      void _exhaustive;
      return [];
    }
  }
}

/**
 * Dispatch call-edge extraction to the language-specific extractor.
 *
 * 0.5.0 ships JS/TS only. Python / Go / Java call extractors are
 * tracked for 0.5.1 — until then those languages still get full chunks,
 * symbols, and imports, but symbol-grain `find_dependencies` returns
 * empty for callers in those languages. The matrix in the README
 * spells this out so users aren't surprised.
 */
function extractCallsForLanguage(args: {
  language: SupportedLanguage;
  filePath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tree: any;
}): ExtractedCall[] {
  switch (args.language) {
    case 'javascript':
    case 'typescript':
      return extractJsCalls({ filePath: args.filePath, tree: args.tree });
    case 'python':
    case 'go':
    case 'java':
      // Per-language call extraction lands in 0.5.1.
      return [];
    default: {
      const _exhaustive: never = args.language;
      void _exhaustive;
      return [];
    }
  }
}

/**
 * Dispatch import extraction to the language-specific extractor. Same
 * rationale as `extractSymbolsForLanguage` — Wave 4 left the dispatch
 * unwired and Python/Go/Java imports never landed in the `imports`
 * table, breaking `find_dependencies` for non-JS/TS sources.
 */
function extractImportsForLanguage(args: {
  language: SupportedLanguage;
  filePath: string;
  absolutePath: string;
  repoRoot: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tree: any;
}): ExtractedImport[] {
  switch (args.language) {
    case 'javascript':
    case 'typescript':
      return extractImports({
        filePath: args.filePath,
        absolutePath: args.absolutePath,
        repoRoot: args.repoRoot,
        tree: args.tree,
        language: args.language,
      });
    case 'python':
      return extractPythonImports({
        filePath: args.filePath,
        absolutePath: args.absolutePath,
        repoRoot: args.repoRoot,
        tree: args.tree,
      });
    case 'go':
      return extractGoImports({
        filePath: args.filePath,
        absolutePath: args.absolutePath,
        repoRoot: args.repoRoot,
        tree: args.tree,
      });
    case 'java':
      return extractJavaImports({
        filePath: args.filePath,
        absolutePath: args.absolutePath,
        repoRoot: args.repoRoot,
        tree: args.tree,
      });
    default: {
      const _exhaustive: never = args.language;
      void _exhaustive;
      return [];
    }
  }
}

/** Options for {@link indexRepo}. */
export interface IndexRepoOptions {
  db: Database.Database;
  embedder: Embedder;
  /** Absolute path to the repo root. */
  rootPath: string;
  /** Extra ignore patterns on top of defaults + .gitignore. */
  additionalIgnore?: string[];
  /**
   * Called after each file is processed (or skipped). Strictly for
   * progress reporting; never affects control flow.
   */
  onProgress?: (args: {
    file: string;
    done: number;
    chunks: number;
    skipped: boolean;
  }) => void;
  /** Skip unchanged files based on `file_hashes.sha256`. Default `true`. */
  incremental?: boolean;
}

/** Aggregate stats returned by {@link indexRepo}. */
export interface IndexRepoResult {
  /** Total files visited (processed + skipped). */
  files: number;
  /** Files whose rows were inserted this run. */
  filesIndexed: number;
  /** Files whose hash matched and were skipped. */
  filesSkipped: number;
  chunks: number;
  symbols: number;
  imports: number;
  /** Call-graph edges extracted this run (0.5.0+; JS/TS only today). */
  calls: number;
  elapsedMs: number;
}

/**
 * Index every supported file under `rootPath`. Incremental by default:
 * files whose SHA256 matches the stored `file_hashes.sha256` are skipped
 * and contribute to `filesSkipped`.
 *
 * Never throws on a per-file parse error — the walker logs and skips. A
 * DB / embedder failure DOES propagate; those are terminal.
 */
export async function indexRepo(opts: IndexRepoOptions): Promise<IndexRepoResult> {
  const incremental = opts.incremental !== false; // default true
  const started = Date.now();

  const stmts = prepareStatements(opts.db);
  const existingHashes = loadExistingHashes(opts.db);

  let files = 0;
  let filesIndexed = 0;
  let filesSkipped = 0;
  let chunkTotal = 0;
  let symbolTotal = 0;
  let importTotal = 0;
  let callTotal = 0;

  for await (const walked of walkRepo(opts.rootPath, {
    additionalIgnore: opts.additionalIgnore,
  })) {
    files += 1;

    const storedHash = existingHashes.get(walked.relativePath);
    const shouldSkip = incremental && storedHash === walked.contentHash;

    if (shouldSkip) {
      filesSkipped += 1;
      opts.onProgress?.({
        file: walked.relativePath,
        done: files,
        chunks: 0,
        skipped: true,
      });
      continue;
    }

    // Chunk + symbols + imports.
    const chunks = chunkFile({
      filePath: walked.relativePath,
      content: walked.content,
      language: walked.language,
      tree: walked.tree,
    });

    const symbols = extractSymbolsForLanguage({
      language: walked.language,
      filePath: walked.relativePath,
      chunks,
      tree: walked.tree,
    });

    const imports = extractImportsForLanguage({
      language: walked.language,
      filePath: walked.relativePath,
      absolutePath: walked.absolutePath,
      repoRoot: opts.rootPath,
      tree: walked.tree,
    });

    const calls = extractCallsForLanguage({
      language: walked.language,
      filePath: walked.relativePath,
      tree: walked.tree,
    });

    // Embed OUTSIDE the transaction — network / mock CPU shouldn't hold
    // a SQLite write lock.
    const embedResp = await opts.embedder.embed({
      input: chunks.map((c) => c.content),
    });
    if (embedResp.vectors.length !== chunks.length) {
      throw new Error(
        `embedder returned ${embedResp.vectors.length} vectors for ` +
          `${chunks.length} chunks in ${walked.relativePath}`,
      );
    }

    const apply = opts.db.transaction(() => {
      // Delete prior rows first — changed-file path. No-ops on a fresh
      // file. Order: FK-referencing tables first, then chunks, then
      // independent imports + call edges.
      stmts.deleteSymbolsByFile.run(walked.relativePath);
      stmts.deleteVecByFile.run(walked.relativePath);
      stmts.deleteChunksByFile.run(walked.relativePath);
      stmts.deleteImportsByFile.run(walked.relativePath);
      stmts.deleteCallEdgesByFile.run(walked.relativePath);

      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        stmts.insertChunk.run(
          c.chunkId,
          c.filePath,
          c.lineStart,
          c.lineEnd,
          c.content,
          c.language,
          walked.contentHash,
        );
        stmts.insertVec.run(c.chunkId, vectorToBuffer(embedResp.vectors[i]));
      }
      for (const s of symbols) {
        stmts.insertSymbol.run(s.nodeId, s.chunkId, s.kind, s.name, s.qualified);
      }
      for (const imp of imports) {
        stmts.insertImport.run(imp.edgeId, imp.srcFile, imp.targetPath, imp.confidence);
      }
      for (const call of calls) {
        stmts.insertCallEdge.run(
          call.edgeId,
          call.callerNodeId,
          call.callerQualified,
          call.calleeName,
          call.calleeQualified,
          walked.relativePath,
          call.callLine,
          call.confidence,
        );
      }
      stmts.insertFileHash.run(walked.relativePath, walked.contentHash, Date.now());
    });
    apply();

    filesIndexed += 1;
    chunkTotal += chunks.length;
    symbolTotal += symbols.length;
    importTotal += imports.length;
    callTotal += calls.length;

    opts.onProgress?.({
      file: walked.relativePath,
      done: files,
      chunks: chunks.length,
      skipped: false,
    });
  }

  return {
    files,
    filesIndexed,
    filesSkipped,
    chunks: chunkTotal,
    symbols: symbolTotal,
    imports: importTotal,
    calls: callTotal,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Options for {@link indexFile}. The watch daemon calls this once per
 * debounced filesystem event.
 */
export interface IndexFileOptions {
  db: Database.Database;
  embedder: Embedder;
  /** Absolute path of the file on disk. */
  absolutePath: string;
  /** Absolute path of the repo root — used to compute the relative key. */
  repoRoot: string;
}

export interface IndexFileResult {
  chunks: number;
  symbols: number;
  imports: number;
  /** Call-graph edges extracted (0.5.0+; JS/TS only today). */
  calls: number;
  skipped: boolean;
}

/**
 * Index a single file. Used by the watch daemon on `add` / `change`
 * events. Returns `{ skipped: true, ... }` if the content hash matches
 * `file_hashes` — the common case for IDE autosaves that flip the mtime
 * without changing bytes.
 *
 * Throws if the file isn't readable or the embedder fails; the caller
 * (watch daemon) is responsible for logging and continuing.
 */
export async function indexFile(opts: IndexFileOptions): Promise<IndexFileResult> {
  const relativePath = toPosixRelative(opts.repoRoot, opts.absolutePath);

  // Language gate — the walker does this too, but a direct caller
  // (the watch daemon) gets an event for every path, including files
  // whose extension we don't support. Skip early.
  const language = detectLanguage(opts.absolutePath);
  if (!language) {
    return { chunks: 0, symbols: 0, imports: 0, calls: 0, skipped: true };
  }

  let content: string;
  try {
    content = await fs.promises.readFile(opts.absolutePath, 'utf8');
  } catch {
    // File disappeared between the event and the read — treat as
    // skipped, not as an error. The `unlink` path handles real deletes.
    return { chunks: 0, symbols: 0, imports: 0, calls: 0, skipped: true };
  }

  const contentHash = sha256Hex(content);

  const existing = opts.db
    .prepare('SELECT sha256 FROM file_hashes WHERE file_path = ?')
    .get(relativePath) as { sha256: string } | undefined;

  if (existing && existing.sha256 === contentHash) {
    return { chunks: 0, symbols: 0, imports: 0, calls: 0, skipped: true };
  }

  // Parse.
  let tree;
  try {
    tree = parseFile(content, language);
  } catch {
    // tree-sitter's native binding threw — skip, don't crash the daemon.
    return { chunks: 0, symbols: 0, imports: 0, calls: 0, skipped: true };
  }

  const chunks = chunkFile({
    filePath: relativePath,
    content,
    language,
    tree,
  });
  const symbols = extractSymbolsForLanguage({
    language,
    filePath: relativePath,
    chunks,
    tree,
  });
  const imports = extractImportsForLanguage({
    language,
    filePath: relativePath,
    absolutePath: opts.absolutePath,
    repoRoot: opts.repoRoot,
    tree,
  });
  const calls = extractCallsForLanguage({
    language,
    filePath: relativePath,
    tree,
  });

  // Embed outside the transaction.
  const embedResp = await opts.embedder.embed({
    input: chunks.map((c) => c.content),
  });
  if (embedResp.vectors.length !== chunks.length) {
    throw new Error(
      `embedder returned ${embedResp.vectors.length} vectors for ` +
        `${chunks.length} chunks in ${relativePath}`,
    );
  }

  const stmts = prepareStatements(opts.db);

  const apply = opts.db.transaction(() => {
    stmts.deleteSymbolsByFile.run(relativePath);
    stmts.deleteVecByFile.run(relativePath);
    stmts.deleteChunksByFile.run(relativePath);
    stmts.deleteImportsByFile.run(relativePath);
    stmts.deleteCallEdgesByFile.run(relativePath);

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      stmts.insertChunk.run(
        c.chunkId,
        c.filePath,
        c.lineStart,
        c.lineEnd,
        c.content,
        c.language,
        contentHash,
      );
      stmts.insertVec.run(c.chunkId, vectorToBuffer(embedResp.vectors[i]));
    }
    for (const s of symbols) {
      stmts.insertSymbol.run(s.nodeId, s.chunkId, s.kind, s.name, s.qualified);
    }
    for (const imp of imports) {
      stmts.insertImport.run(imp.edgeId, imp.srcFile, imp.targetPath, imp.confidence);
    }
    for (const call of calls) {
      stmts.insertCallEdge.run(
        call.edgeId,
        call.callerNodeId,
        call.callerQualified,
        call.calleeName,
        call.calleeQualified,
        relativePath,
        call.callLine,
        call.confidence,
      );
    }
    stmts.insertFileHash.run(relativePath, contentHash, Date.now());
  });
  apply();

  return {
    chunks: chunks.length,
    symbols: symbols.length,
    imports: imports.length,
    calls: calls.length,
    skipped: false,
  };
}

/**
 * Remove every row associated with `filePath` (repo-relative, POSIX).
 * Called by the watch daemon on `unlink` events.
 *
 * Cascade order: symbols reference `chunk_id` via `REFERENCES`, so we
 * delete them first to avoid FK constraint errors. `code_chunks_vec` is
 * keyed by `chunk_id` too. `imports` and `file_hashes` are keyed by
 * path directly.
 */
export function removeFile(args: {
  db: Database.Database;
  filePath: string;
}): void {
  const { db, filePath } = args;

  const remove = db.transaction(() => {
    // Enumerate chunk IDs before we delete them — the FK cascade is
    // not configured on symbols (the schema uses REFERENCES without ON
    // DELETE), so we clean up dependents manually.
    const chunkIds = db
      .prepare('SELECT id FROM code_chunks WHERE file_path = ?')
      .all(filePath) as Array<{ id: string }>;

    if (chunkIds.length > 0) {
      const placeholders = chunkIds.map(() => '?').join(',');
      const ids = chunkIds.map((r) => r.id);
      db.prepare(`DELETE FROM symbols WHERE chunk_id IN (${placeholders})`).run(
        ...ids,
      );
      db.prepare(
        `DELETE FROM code_chunks_vec WHERE chunk_id IN (${placeholders})`,
      ).run(...ids);
    }

    db.prepare('DELETE FROM code_chunks WHERE file_path = ?').run(filePath);
    db.prepare('DELETE FROM imports WHERE src_file = ?').run(filePath);
    db.prepare('DELETE FROM call_edges WHERE src_file = ?').run(filePath);
    db.prepare('DELETE FROM file_hashes WHERE file_path = ?').run(filePath);
  });

  remove();
}

/**
 * Prepare all the statements we reuse per file. Building them once and
 * reusing them is the single biggest perf win on the ingest path — the
 * Wave 3 bench shows ~6× speedup vs `db.run(sql, ...)` per file.
 */
function prepareStatements(db: Database.Database) {
  return {
    insertChunk: db.prepare(
      `INSERT OR REPLACE INTO code_chunks
         (id, file_path, line_start, line_end, content, language, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertSymbol: db.prepare(
      `INSERT OR REPLACE INTO symbols (node_id, chunk_id, kind, name, qualified)
         VALUES (?, ?, ?, ?, ?)`,
    ),
    insertImport: db.prepare(
      `INSERT OR REPLACE INTO imports (edge_id, src_file, target_path, confidence)
         VALUES (?, ?, ?, ?)`,
    ),
    insertFileHash: db.prepare(
      `INSERT OR REPLACE INTO file_hashes (file_path, sha256, indexed_at)
         VALUES (?, ?, ?)`,
    ),
    insertVec: db.prepare(
      `INSERT OR REPLACE INTO code_chunks_vec (chunk_id, embedding) VALUES (?, ?)`,
    ),
    // Delete order matters: symbols + vec rows FK-reference chunks, so we
    // clear them first via IN subqueries, then drop the chunk rows, then
    // the import edges (independent).
    deleteSymbolsByFile: db.prepare(
      `DELETE FROM symbols WHERE chunk_id IN (SELECT id FROM code_chunks WHERE file_path = ?)`,
    ),
    deleteVecByFile: db.prepare(
      `DELETE FROM code_chunks_vec WHERE chunk_id IN (SELECT id FROM code_chunks WHERE file_path = ?)`,
    ),
    deleteChunksByFile: db.prepare(
      `DELETE FROM code_chunks WHERE file_path = ?`,
    ),
    deleteImportsByFile: db.prepare(
      `DELETE FROM imports WHERE src_file = ?`,
    ),
    insertCallEdge: db.prepare(
      `INSERT OR REPLACE INTO call_edges
         (edge_id, caller_node_id, caller_qualified, callee_name,
          callee_qualified, src_file, call_line, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    deleteCallEdgesByFile: db.prepare(
      `DELETE FROM call_edges WHERE src_file = ?`,
    ),
  };
}

function loadExistingHashes(db: Database.Database): Map<string, string> {
  const rows = db
    .prepare('SELECT file_path, sha256 FROM file_hashes')
    .all() as Array<{ file_path: string; sha256: string }>;
  const m = new Map<string, string>();
  for (const r of rows) m.set(r.file_path, r.sha256);
  return m;
}

/**
 * sqlite-vec stores embeddings as raw little-endian float32 blobs in a
 * `vec0` virtual table. Float32Array is LE on every platform Node
 * supports, so we just view the backing buffer. Lifted from
 * `benchmarks/index-10k.bench.ts` — keep the two in sync until Wave 5
 * removes the duplication.
 */
export function vectorToBuffer(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function toPosixRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}
