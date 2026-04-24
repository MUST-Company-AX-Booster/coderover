/**
 * Phase 11 Wave 4 — L17: `coderover watch` CLI.
 *
 *   coderover watch [path] [--debounce-ms N] [--embed mock|openai|offline]
 *                   [--verbose] [--help]
 *
 * Runs an initial index (incremental — likely to report "already up-to-
 * date" on a warm DB), then starts the watch daemon and blocks until
 * SIGINT / SIGTERM. On shutdown prints final stats and exits 0.
 *
 * Signal handling is wired through injectable test seams: tests supply
 * a fake `waitForShutdown` that resolves immediately so `runWatchCmd`
 * returns without waiting for a real signal.
 */

import type Database from 'better-sqlite3';

import { indexRepo } from '../../local/pipeline';
import type { Embedder } from '../../local/embed/types';
import {
  startWatch,
  type WatchHandle,
  type WatchOptions,
  type WatcherBackend,
} from '../../local/watch/watch-daemon';
import {
  buildEmbedder,
  openIndexedDb,
  resolveDbPath,
  resolveProjectRoot,
} from './shared';
import { touchMeta } from './meta';

export interface WatchCmdArgs {
  path?: string;
  embed?: 'mock' | 'openai' | 'offline';
  verbose?: boolean;
  help?: boolean;
  debounceMs?: number;
  unknown?: string;
}

export interface WatchCmdDeps {
  resolveDbPath?: (projectRoot: string) => string;
  buildEmbedder?: (mode?: 'mock' | 'openai' | 'offline') => Embedder;
  resolveProjectRoot?: (input: string | undefined) => string;
  openIndexedDb?: (dbPath: string) => Promise<Database.Database>;
  /** Override the watcher backend (tests inject a fake). */
  watcherBackend?: WatcherBackend;
  /**
   * Test-only. Returns when the CLI should initiate shutdown — a live
   * process resolves this on SIGINT / SIGTERM; tests can resolve it
   * synchronously to drive the shutdown path.
   */
  waitForShutdown?: (handle: WatchHandle) => Promise<void>;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export function parseWatchArgs(argv: string[]): WatchCmdArgs {
  const out: WatchCmdArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--help' || tok === '-h') {
      out.help = true;
      continue;
    }
    if (tok === '--verbose') {
      out.verbose = true;
      continue;
    }
    if (tok === '--embed') {
      const val = argv[i + 1];
      if (val === 'mock' || val === 'openai' || val === 'offline') {
        out.embed = val;
        i++;
        continue;
      }
      out.unknown = `--embed requires mock|openai|offline, got ${val ?? '<none>'}`;
      if (val !== undefined) i++;
      continue;
    }
    if (tok.startsWith('--embed=')) {
      const val = tok.slice('--embed='.length);
      if (val === 'mock' || val === 'openai' || val === 'offline') {
        out.embed = val;
        continue;
      }
      out.unknown = `--embed requires mock|openai|offline, got ${val}`;
      continue;
    }
    if (tok === '--debounce-ms') {
      const val = argv[i + 1];
      const n = Number(val);
      if (val === undefined || !Number.isFinite(n) || n < 0) {
        out.unknown = `--debounce-ms requires a non-negative number, got ${val ?? '<none>'}`;
        if (val !== undefined) i++;
        continue;
      }
      out.debounceMs = n;
      i++;
      continue;
    }
    if (tok.startsWith('--debounce-ms=')) {
      const val = tok.slice('--debounce-ms='.length);
      const n = Number(val);
      if (!Number.isFinite(n) || n < 0) {
        out.unknown = `--debounce-ms requires a non-negative number, got ${val}`;
        continue;
      }
      out.debounceMs = n;
      continue;
    }
    if (tok.startsWith('--')) {
      out.unknown = `unknown flag: ${tok}`;
      continue;
    }
    if (out.path === undefined) {
      out.path = tok;
    } else {
      out.unknown = `unexpected positional: ${tok}`;
    }
  }
  return out;
}

export function helpText(): string {
  return [
    'coderover watch [path] [--debounce-ms N] [--embed mock|openai|offline] [--verbose]',
    '',
    'Watch [path] for source-file changes and keep the local SQLite index in',
    'sync. Runs an initial index first so the DB is caught up before the',
    'daemon starts. Exits 0 on SIGINT / SIGTERM after flushing pending',
    'debounced events.',
    '',
    'FLAGS',
    '  --debounce-ms N      Per-path debounce window. Default 500.',
    '  --embed mock|openai|offline  Embedder mode. Default: openai.',
    '  --verbose            Emit a JSON log line per event.',
    '  -h, --help           Show this message.',
    '',
  ].join('\n');
}

/**
 * Default shutdown waiter — resolves on SIGINT / SIGTERM. Factored
 * out so tests can substitute an immediate-resolve variant.
 */
function defaultWaitForShutdown(): Promise<void> {
  return new Promise<void>((resolve) => {
    const onSig = (): void => {
      // Dereference listeners so the process can exit.
      process.off('SIGINT', onSig);
      process.off('SIGTERM', onSig);
      resolve();
    };
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);
  });
}

/**
 * Execute `coderover watch`. Blocks until shutdown is signalled (or
 * until `deps.waitForShutdown` resolves for tests).
 *
 * Exit codes:
 *   0 → clean shutdown
 *   1 → runtime failure
 *   2 → bad CLI usage
 */
export async function runWatchCmd(
  argv: string[],
  deps: WatchCmdDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const _resolveProjectRoot = deps.resolveProjectRoot ?? resolveProjectRoot;
  const _resolveDbPath = deps.resolveDbPath ?? resolveDbPath;
  const _buildEmbedder = deps.buildEmbedder ?? buildEmbedder;
  const _openIndexedDb = deps.openIndexedDb ?? openIndexedDb;
  const _waitForShutdown = deps.waitForShutdown ?? (() => defaultWaitForShutdown());

  const args = parseWatchArgs(argv);
  if (args.help) {
    stdout.write(helpText());
    return 0;
  }
  if (args.unknown) {
    stderr.write(`[coderover watch] ${args.unknown}\n`);
    return 2;
  }

  const projectRoot = _resolveProjectRoot(args.path);
  const dbPath = _resolveDbPath(projectRoot);

  let db: Database.Database;
  try {
    db = await _openIndexedDb(dbPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`[coderover watch] failed to open database at ${dbPath}: ${msg}\n`);
    return 1;
  }
  touchMeta(dbPath, projectRoot);

  const embedder = _buildEmbedder(args.embed);

  let handle: WatchHandle | null = null;
  try {
    stdout.write(`[coderover watch] root=${projectRoot}\n`);
    stdout.write(`[coderover watch] db=${dbPath}\n`);

    // Initial catch-up index. Incremental — warm repos print
    // "already up-to-date" and land near-instantly.
    stdout.write('[coderover watch] running initial index...\n');
    const initial = await indexRepo({
      db,
      embedder,
      rootPath: projectRoot,
      incremental: true,
    });
    if (initial.filesIndexed === 0) {
      stdout.write(
        `[coderover watch] already up-to-date (${initial.filesSkipped} files)\n`,
      );
    } else {
      stdout.write(
        `[coderover watch] indexed ${initial.filesIndexed} files ` +
          `(${initial.filesSkipped} skipped, ${initial.chunks} chunks)\n`,
      );
    }

    // Launch the daemon.
    const watchOpts: WatchOptions = {
      db,
      embedder,
      rootPath: projectRoot,
      debounceMs: args.debounceMs,
      verbose: args.verbose,
    };
    if (deps.watcherBackend) {
      watchOpts.watcherBackend = deps.watcherBackend;
    }

    handle = await startWatch(watchOpts);
    stdout.write(
      `[coderover watch] daemon started (debounce=${args.debounceMs ?? 500}ms). Ctrl-C to stop.\n`,
    );

    await _waitForShutdown(handle);

    const stats = await handle.stop();
    stdout.write(
      [
        '',
        `events     ${stats.events}`,
        `debounced  ${stats.debounced}`,
        `processed  ${stats.processed}`,
        `skipped    ${stats.skipped}`,
        `deleted    ${stats.deleted}`,
        '',
      ].join('\n'),
    );
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`[coderover watch] failed: ${msg}\n`);
    // Best-effort stop if we got far enough to start the daemon.
    if (handle) {
      try {
        await handle.stop();
      } catch {
        // ignore
      }
    }
    return 1;
  } finally {
    try {
      db.close();
    } catch {
      // Already closed — nothing to do.
    }
  }
}
