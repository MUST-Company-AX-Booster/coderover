/**
 * Phase 11 Wave 4 — L17: `coderover reindex` CLI.
 *
 *   coderover reindex [path] [--embed mock|openai|offline] [--verbose] [--help]
 *
 * Destroys the on-disk SQLite DB for the project and rebuilds it from
 * scratch — every file re-parsed, re-chunked, re-embedded, re-inserted.
 *
 * Why two commands instead of a `--force` flag on `index`? A destructive
 * no-undo operation deserves a visible verb. Users who type `reindex`
 * know they're asking for a wipe; users who type `index --force` might
 * not. Keeping them separate makes the intent legible in shell history.
 *
 * Delegates all flag parsing + run logic to the shared helpers in
 * `shared.ts` and `index-cmd.ts`; the only behavioural difference is
 * that we unlink the DB file before opening it.
 */

import * as fs from 'fs';

import type Database from 'better-sqlite3';

import { indexRepo, type IndexRepoResult } from '../../local/pipeline';
import type { Embedder } from '../../local/embed/types';
import {
  buildEmbedder,
  openIndexedDb,
  resolveDbPath,
  resolveProjectRoot,
} from './shared';
import { parseIndexArgs } from './index-cmd';
import { touchMeta, removeMeta } from './meta';

export interface ReindexCmdDeps {
  resolveDbPath?: (projectRoot: string) => string;
  buildEmbedder?: (mode?: 'mock' | 'openai' | 'offline') => Embedder;
  resolveProjectRoot?: (input: string | undefined) => string;
  openIndexedDb?: (dbPath: string) => Promise<Database.Database>;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export function helpText(): string {
  return [
    'coderover reindex [path] [--embed mock|openai|offline] [--verbose]',
    '',
    'Delete the local SQLite DB for the project and rebuild it from scratch.',
    'Use this after a grammar upgrade, embedding-model swap, or when the',
    'on-disk state looks suspect. See `coderover index --help` for the',
    'non-destructive default.',
    '',
    'FLAGS',
    '  --embed mock|openai|offline  Embedder mode. Default: openai.',
    '  --verbose            Print one line per indexed file.',
    '  -h, --help           Show this message.',
    '',
  ].join('\n');
}

/**
 * Execute `coderover reindex`.
 *
 * Exit codes:
 *   0 → success
 *   1 → runtime failure
 *   2 → bad CLI usage
 */
export async function runReindexCmd(
  argv: string[],
  deps: ReindexCmdDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const _resolveProjectRoot = deps.resolveProjectRoot ?? resolveProjectRoot;
  const _resolveDbPath = deps.resolveDbPath ?? resolveDbPath;
  const _buildEmbedder = deps.buildEmbedder ?? buildEmbedder;
  const _openIndexedDb = deps.openIndexedDb ?? openIndexedDb;

  const args = parseIndexArgs(argv);
  if (args.help) {
    stdout.write(helpText());
    return 0;
  }
  if (args.unknown) {
    stderr.write(`[coderover reindex] ${args.unknown}\n`);
    return 2;
  }

  const projectRoot = _resolveProjectRoot(args.path);
  const dbPath = _resolveDbPath(projectRoot);

  // Nuke the DB file + the -wal / -shm siblings. Opening
  // better-sqlite3 with WAL leaves these sidecar files; if we don't
  // unlink them a subsequent open may see stale cache entries.
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stderr.write(`[coderover reindex] failed to remove ${p}: ${msg}\n`);
      return 1;
    }
  }
  // Drop the stale meta so the rebuild's firstIndexedAt reflects the
  // wipe-and-rebuild point, not the original index creation.
  removeMeta(dbPath);

  let db: Database.Database;
  try {
    db = await _openIndexedDb(dbPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`[coderover reindex] failed to open database at ${dbPath}: ${msg}\n`);
    return 1;
  }
  touchMeta(dbPath, projectRoot);

  const embedder = _buildEmbedder(args.embed);

  try {
    const started = Date.now();
    stdout.write(`[coderover reindex] root=${projectRoot}\n`);
    stdout.write(`[coderover reindex] db=${dbPath} (wiped)\n`);

    const result: IndexRepoResult = await indexRepo({
      db,
      embedder,
      rootPath: projectRoot,
      // Full reindex: do NOT honour `file_hashes`. The DB is fresh
      // anyway so every file is a miss, but being explicit here
      // guards against accidental reuse if the unlink step were to
      // silently fail on a future code path.
      incremental: false,
      onProgress: args.verbose
        ? (p) => {
            stdout.write(
              `[coderover reindex] ${p.done}: index (${p.chunks} chunks) ${p.file}\n`,
            );
          }
        : undefined,
    });

    const elapsedMs = Date.now() - started;
    stdout.write(
      [
        '',
        `files      ${result.files}`,
        `indexed    ${result.filesIndexed}`,
        `chunks     ${result.chunks}`,
        `symbols    ${result.symbols}`,
        `imports    ${result.imports}`,
        `elapsed    ${(elapsedMs / 1000).toFixed(2)}s`,
        '',
      ].join('\n'),
    );
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`[coderover reindex] failed: ${msg}\n`);
    return 1;
  } finally {
    try {
      db.close();
    } catch {
      // Already closed — nothing to do.
    }
  }
}
