/**
 * Phase 11 Wave 4 — L16: local-mode watch daemon.
 *
 * Thin wrapper over `@parcel/watcher` + per-path debouncing that drives
 * {@link indexFile} and {@link removeFile} from `pipeline.ts` on every
 * debounced filesystem event.
 *
 * ### What this is NOT
 *
 * The backend's `coderover-api/src/ingest/watch-daemon.service.ts`
 * (Phase 10 C3) is a ~500-line NestJS service with BullMQ, Prometheus
 * metrics, a `BudgetGuard` backpressure hook, and `IncrementalIngestService`
 * wiring. This file is deliberately smaller:
 *
 *   - No NestJS DI — plain `startWatch(opts)` factory.
 *   - No BullMQ queue — we call the pipeline inline.
 *   - No MetricsService — a `verbose` flag + caller-supplied `onEvent`
 *     hook replaces the prom histogram surface.
 *   - No backpressure guard — see TODO below. A Wave-5 follow-up wires
 *     a token / rate guard equivalent to the backend's C4 work.
 *
 * ### Debouncing
 *
 * Per-path map + `setTimeout(debounceMs)`. Successive events on the same
 * path reset the timer. A single file edited five times in 200 ms
 * produces exactly one `indexFile` call. This matches the backend
 * daemon's behaviour byte-for-byte so the two modes feel the same.
 *
 * Timers are `.unref()`ed so the node event loop can exit while watches
 * are pending. `stop()` / `flush()` force-fire any outstanding timers
 * so a SIGINT at the right instant doesn't lose the last edit.
 *
 * ### Test seams
 *
 * - `watcherBackend` injects a fake that exposes `fireEvent(...)` — the
 *   tests never touch the real `@parcel/watcher`.
 * - `onEvent` fires after each debounced event is processed so tests
 *   can assert without polling. Production also uses it for CLI
 *   verbose-mode output.
 */

import * as fs from 'fs';
import * as path from 'path';
import type Database from 'better-sqlite3';

import { buildIgnoreMatcher } from '../ingest/ignore';
import { indexFile, removeFile } from '../pipeline';
import type { Embedder } from '../embed/types';

/** The three shapes the rest of the daemon deals in. */
export type WatchAction = 'add' | 'change' | 'unlink';

export interface WatcherSubscription {
  unsubscribe(): Promise<void>;
}

/** Minimal interface we need from the FS watcher backend. */
export interface WatcherBackend {
  subscribe(
    rootPath: string,
    onEvents: (err: Error | null, events: RawFsEvent[]) => void,
    opts: { ignore: string[] },
  ): Promise<WatcherSubscription>;
}

/** Raw event shape from `@parcel/watcher`. */
export interface RawFsEvent {
  type: 'create' | 'update' | 'delete';
  path: string;
}

export interface WatchOptions {
  db: Database.Database;
  embedder: Embedder;
  /** Absolute path to the repo root. */
  rootPath: string;
  /** Per-path debounce window, ms. Default 500. */
  debounceMs?: number;
  /** Extra ignore patterns on top of defaults + .gitignore. */
  additionalIgnore?: string[];
  /** Test-only override for the fs-watcher backend. */
  watcherBackend?: WatcherBackend;
  /** Emit structured per-event logs to stdout. */
  verbose?: boolean;
  /** Called once per debounced event (after processing). */
  onEvent?: (args: {
    filePath: string;
    action: WatchAction;
    durationMs: number;
    chunks: number;
    skipped: boolean;
  }) => void;
  /** Test-only clock override. */
  now?: () => number;
}

export interface WatchStats {
  /** Raw events observed from the watcher. */
  events: number;
  /** Debounced events that actually fired the ingest path. */
  debounced: number;
  /** Files where `indexFile` inserted rows. */
  processed: number;
  /** Files where `removeFile` was called. */
  deleted: number;
  /** Files where `indexFile` returned `skipped: true`. */
  skipped: number;
  /** Debounce-queue depth at last sample. */
  queueDepth: number;
  startedAt: number;
  lastEventAt: number | null;
}

export interface WatchHandle {
  stop(): Promise<WatchStats>;
  stats(): WatchStats;
  /** Force-fire every pending debounce. Exposed for tests + `stop()`. */
  flush(): Promise<void>;
}

interface PendingEntry {
  action: WatchAction;
  absolutePath: string;
  relativePath: string;
  timer: NodeJS.Timeout | null;
}

/**
 * Ignore patterns passed to the parcel-watcher backend. `@parcel/watcher`
 * uses a glob format; we pass the same top-level directories the
 * `buildIgnoreMatcher` default set skips so the watcher doesn't even
 * emit events for them. The matcher still runs on every event — it
 * honours `.gitignore` and the caller's additional patterns which the
 * backend can't see.
 */
const PARCEL_WATCHER_IGNORE: string[] = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'target',
  '__pycache__',
  '.coderover',
  'coverage',
];

/**
 * Start a watch daemon. Returns a handle whose `stop()` unsubscribes
 * the backend and flushes any pending debounced events so no edits are
 * lost to a ctrl-C at the wrong instant.
 *
 * The returned handle is live — do not call `db.close()` while it's
 * running. The handle owns no DB mutex; SQLite's WAL mode lets readers
 * proceed concurrently with the daemon's writes.
 */
export async function startWatch(opts: WatchOptions): Promise<WatchHandle> {
  const absolute = path.resolve(opts.rootPath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`startWatch: path not found: ${absolute}`);
  }

  const debounceMs = opts.debounceMs ?? 500;
  const verbose = opts.verbose ?? false;
  const now = opts.now ?? Date.now;
  const ignoreMatcher = buildIgnoreMatcher(absolute, opts.additionalIgnore);

  const stats: WatchStats = {
    events: 0,
    debounced: 0,
    processed: 0,
    deleted: 0,
    skipped: 0,
    queueDepth: 0,
    startedAt: now(),
    lastEventAt: null,
  };

  const pending = new Map<string, PendingEntry>();

  const recordQueueDepth = (): void => {
    stats.queueDepth = pending.size;
  };

  const processEntry = async (relativePath: string): Promise<void> => {
    const entry = pending.get(relativePath);
    if (!entry) return;
    pending.delete(relativePath);
    recordQueueDepth();

    stats.debounced += 1;
    const processStart = now();

    try {
      if (entry.action === 'unlink') {
        removeFile({ db: opts.db, filePath: entry.relativePath });
        stats.deleted += 1;
        opts.onEvent?.({
          filePath: entry.relativePath,
          action: 'unlink',
          durationMs: now() - processStart,
          chunks: 0,
          skipped: false,
        });
        if (verbose) {
          logStructured({
            event: 'watch',
            filePath: entry.relativePath,
            action: 'unlink',
            durationMs: now() - processStart,
          });
        }
      } else {
        const result = await indexFile({
          db: opts.db,
          embedder: opts.embedder,
          absolutePath: entry.absolutePath,
          repoRoot: absolute,
        });
        if (result.skipped) {
          stats.skipped += 1;
        } else {
          stats.processed += 1;
        }
        opts.onEvent?.({
          filePath: entry.relativePath,
          action: entry.action,
          durationMs: now() - processStart,
          chunks: result.chunks,
          skipped: result.skipped,
        });
        if (verbose) {
          logStructured({
            event: 'watch',
            filePath: entry.relativePath,
            action: entry.action,
            durationMs: now() - processStart,
            chunks: result.chunks,
            skipped: result.skipped,
          });
        }
      }
    } catch (err) {
      // The pipeline can throw on embedder failure. Log and continue —
      // the daemon is long-running and must survive transient errors.
      // TODO(wave5): wire a backpressure guard so repeated embedder
      // failures pause the daemon instead of busy-looping.
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`[watch] handler failed for ${entry.relativePath}: ${msg}`);
    }
  };

  const enqueue = (action: WatchAction, absolutePath: string): void => {
    // The backend may give us paths outside root (rare, but observed on
    // symlink chains). Skip them rather than compute a broken relpath.
    const rel = toPosixRelative(absolute, absolutePath);
    if (!rel || rel.startsWith('..')) return;
    if (ignoreMatcher(rel)) return;

    stats.events += 1;
    stats.lastEventAt = now();

    const prior = pending.get(rel);
    if (prior?.timer) clearTimeout(prior.timer);

    // eslint-disable-next-line prefer-const
    let timer: NodeJS.Timeout;
    const entry: PendingEntry = {
      action,
      absolutePath,
      relativePath: rel,
      timer: null,
    };
    timer = setTimeout(() => {
      void processEntry(rel);
    }, debounceMs);
    if (typeof timer.unref === 'function') timer.unref();
    entry.timer = timer;
    pending.set(rel, entry);
    recordQueueDepth();

    if (verbose) {
      logStructured({
        event: 'watch-enqueue',
        filePath: rel,
        action,
        queueDepth: pending.size,
      });
    }
  };

  const backend = opts.watcherBackend ?? (await loadParcelBackend());
  const subscription = await backend.subscribe(
    absolute,
    (err, events) => {
      if (err) {
        // eslint-disable-next-line no-console
        console.warn(`[watch] backend error: ${err.message}`);
        return;
      }
      for (const ev of events) {
        const action: WatchAction =
          ev.type === 'create'
            ? 'add'
            : ev.type === 'update'
              ? 'change'
              : 'unlink';
        enqueue(action, ev.path);
      }
    },
    { ignore: PARCEL_WATCHER_IGNORE },
  );

  const flush = async (): Promise<void> => {
    const paths = [...pending.keys()];
    for (const p of paths) {
      const entry = pending.get(p);
      if (entry?.timer) clearTimeout(entry.timer);
      await processEntry(p);
    }
  };

  const stop = async (): Promise<WatchStats> => {
    try {
      await subscription.unsubscribe();
    } catch (unsubErr) {
      const msg = unsubErr instanceof Error ? unsubErr.message : String(unsubErr);
      // eslint-disable-next-line no-console
      console.warn(`[watch] unsubscribe failed: ${msg}`);
    }
    await flush();
    return { ...stats };
  };

  return {
    stop,
    stats: () => ({ ...stats }),
    flush,
  };
}

function toPosixRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

function logStructured(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload));
}

/**
 * Lazy-load `@parcel/watcher` so tests that inject a mock backend do
 * not pay the native binding load cost, and so platforms without the
 * binary available see a clear failure only when they actually need
 * the real watcher.
 */
// Narrow structural type for the slice of `@parcel/watcher` we use.
// Declared locally so this module type-checks in environments where
// the native dep isn't installed yet. Matches the real API shape.
interface ParcelWatcherModule {
  subscribe(
    rootPath: string,
    onEvents: (err: Error | null, events: RawFsEvent[]) => void,
    opts: { ignore?: string[] },
  ): Promise<{ unsubscribe: () => Promise<void> }>;
}

async function loadParcelBackend(): Promise<WatcherBackend> {
  // Import lazily to keep the module importable in environments where
  // the native dep isn't installed yet. The tests inject their own
  // backend; CI paths that reach this branch are expected to have it.
  let mod: ParcelWatcherModule;
  try {
    // Indirection through a dynamic string keeps the TS compiler from
    // failing the build when the dep isn't declared — the runtime
    // resolution is identical to a direct `await import(...)`.
    const modName = '@parcel/watcher';
    mod = (await import(modName)) as ParcelWatcherModule;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `@parcel/watcher is required for the watch daemon but could not ` +
        `be loaded: ${msg}. Install it via \`npm install @parcel/watcher\`.`,
    );
  }
  return {
    subscribe: async (rootPath, onEvents, subOpts) => {
      const sub = await mod.subscribe(
        rootPath,
        (err: Error | null, events: RawFsEvent[]) => onEvents(err, events),
        { ignore: subOpts.ignore },
      );
      return { unsubscribe: (): Promise<void> => sub.unsubscribe() };
    },
  };
}
