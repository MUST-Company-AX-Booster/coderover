import { Injectable, Logger, Optional } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import { IncrementalIngestService, ProcessFn } from './incremental-ingest.service';
import { MetricsService } from '../observability/metrics.service';
import { buildIgnoreMatcher } from './watch-ignore';

/**
 * Phase 10 C3 — filesystem watch daemon.
 *
 * A long-running service that watches a repo root and drives
 * `IncrementalIngestService` on every observed filesystem event,
 * de-bounced so that IDE autosave storms don't overwhelm the cache
 * layer.
 *
 * ### Wiring contract
 *
 * Callers provide a `processFn` factory keyed on `(repoId, filePath,
 * content)`. The daemon itself knows NOTHING about chunking, AST, or
 * embedding — it just debounces events and hands off to the C2
 * `IncrementalIngestService`, which hashes the content, decides
 * skip/process, and calls `processFn` only on miss.
 *
 * If no `processFn` factory is provided, the daemon runs in
 * OBSERVE-ONLY mode: it debounces, logs, counts, and reports stats
 * but does not touch the ingestion pipeline. This is deliberately
 * supported so that the watch loop is verifiable in isolation — a
 * C2-follow-up PR wires the real processor.
 *
 * ### Back-pressure
 *
 * An optional `BudgetGuard` (see `WatchOptions.budgetGuard`) is
 * consulted before each batch fires. A permissive guard returns
 * `{ ok: true }`; an over-limit guard returns `{ ok: false,
 * retryAfterMs }`. While paused, events still queue up. A
 * `watch-paused` structured log fires on entry; `watch-resumed` on
 * exit.
 *
 * The canonical guard implementation will be `TokenCapService` once
 * the per-repo → per-org wiring lands (C4 follow-up). Until then the
 * interface is test-only; absent a guard the daemon always proceeds.
 *
 * ### Observability
 *
 * Every processed event emits:
 *
 *     { event: 'watch', repoId, filePath, action, reason,
 *       durationMs, queueDepth }
 *
 * If a `MetricsService` is injected, the daemon also records:
 *
 *   - coderover_watch_events_total{repoId, action}  counter
 *   - coderover_watch_debounce_seconds               histogram
 *   - coderover_watch_processing_seconds{action}     histogram
 *   - coderover_watch_queue_depth{repoId}            gauge
 *   - coderover_watch_lag_seconds{repoId}            gauge
 *
 * In standalone CLI mode (no Nest container) `MetricsService` is
 * undefined and the values show up in the structured log only.
 */

export type WatchAction = 'add' | 'change' | 'unlink';

export interface WatchOptions {
  /** Debounce window per path in ms. Default 500. */
  debounceMs?: number;

  /** Additional ignore patterns on top of defaults + .gitignore. */
  additionalIgnore?: string[];

  /**
   * Called to build the ingest `processFn` for one (changed) file.
   * If omitted, the daemon runs in observe-only mode.
   */
  processFnFactory?: (args: {
    repoId: string;
    absolutePath: string;
    relativePath: string;
    action: WatchAction;
  }) => ProcessFn;

  /** Back-pressure hook. See service header. */
  budgetGuard?: BudgetGuard;

  /** Forward verbose debounce events to logs. */
  verbose?: boolean;

  /**
   * Override the watcher backend. Used by tests to inject a mock.
   * Production picks `@parcel/watcher` at runtime.
   */
  watcherBackend?: WatcherBackend;

  /** Test-only clock override. */
  now?: () => number;
}

export interface BudgetGuard {
  /**
   * Called once per batch before the ingest fan-out. Return
   * `{ ok: true }` to proceed, or `{ ok: false, retryAfterMs }` to
   * pause the daemon.
   */
  check(repoId: string, pendingCount: number): Promise<
    { ok: true } | { ok: false; retryAfterMs: number; reason?: string }
  >;
}

/**
 * Minimal interface we need from the FS watcher. Both `@parcel/
 * watcher` and test mocks satisfy it.
 */
export interface WatcherSubscription {
  unsubscribe(): Promise<void>;
}
export interface WatcherBackend {
  subscribe(
    rootPath: string,
    onEvents: (err: Error | null, events: RawFsEvent[]) => void,
    opts: { ignore: string[] },
  ): Promise<WatcherSubscription>;
}

export interface RawFsEvent {
  type: 'create' | 'update' | 'delete';
  path: string;
}

export interface WatchStats {
  events: number;
  debounced: number;
  processed: number;
  deleted: number;
  skipped: number;
  queueDepth: number;
  lastEventAt: number | null;
  lastProcessedAt: number | null;
  pausedEvents: number;
}

export interface WatchHandle {
  stop(): Promise<WatchStats>;
  stats(): WatchStats;
  /** Force-flush the debounce queue. Exposed for tests. */
  flush(): Promise<void>;
}

interface PendingEntry {
  action: WatchAction;
  absolutePath: string;
  relativePath: string;
  firstSeenAt: number;
  lastSeenAt: number;
  timer: NodeJS.Timeout | null;
}

@Injectable()
export class WatchDaemonService {
  private readonly logger = new Logger(WatchDaemonService.name);

  constructor(
    @Optional() private readonly incremental?: IncrementalIngestService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async start(
    repoId: string,
    rootPath: string,
    opts: WatchOptions = {},
  ): Promise<WatchHandle> {
    const absolute = path.resolve(rootPath);
    if (!fs.existsSync(absolute)) {
      throw new Error(`path not found: ${absolute}`);
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
      lastEventAt: null,
      lastProcessedAt: null,
      pausedEvents: 0,
    };

    const pending = new Map<string, PendingEntry>();
    let paused = false;
    let stopping = false;

    const recordQueueGauge = () => {
      stats.queueDepth = pending.size;
      this.metrics?.set('coderover_watch_queue_depth', pending.size, { repoId });
    };

    const recordLagGauge = () => {
      if (stats.lastEventAt == null) return;
      const lag = Math.max(0, (stats.lastProcessedAt ?? now()) - stats.lastEventAt);
      this.metrics?.set(
        'coderover_watch_lag_seconds',
        lag / 1000,
        { repoId },
      );
    };

    const flushPath = async (relPath: string) => {
      const entry = pending.get(relPath);
      if (!entry) return;
      pending.delete(relPath);
      recordQueueGauge();

      const debounceWaited = now() - entry.firstSeenAt;
      stats.debounced += 1;
      this.metrics?.observe(
        'coderover_watch_debounce_seconds',
        debounceWaited / 1000,
      );

      if (verbose) {
        this.logStructured({
          event: 'watch-debounce-fire',
          repoId,
          filePath: relPath,
          action: entry.action,
          waitedMs: debounceWaited,
          queueDepth: pending.size,
        });
      }

      // Back-pressure
      if (opts.budgetGuard) {
        const decision = await opts.budgetGuard.check(repoId, pending.size + 1);
        if (!decision.ok) {
          paused = true;
          stats.pausedEvents += 1;
          this.logStructured({
            event: 'watch-paused',
            repoId,
            filePath: relPath,
            reason: decision.reason ?? 'budget-exceeded',
            retryAfterMs: decision.retryAfterMs,
          });
          // Put it back and arm a resume timer.
          pending.set(relPath, { ...entry, timer: null });
          recordQueueGauge();
          setTimeout(() => {
            if (stopping) return;
            paused = false;
            this.logStructured({ event: 'watch-resumed', repoId });
            // Re-arm every queued entry's debounce (runs it immediately).
            for (const [p] of pending) {
              void flushPath(p);
            }
          }, decision.retryAfterMs);
          return;
        }
      }
      if (paused) {
        // Re-queue if a parallel pause is in effect.
        pending.set(relPath, { ...entry, timer: null });
        recordQueueGauge();
        return;
      }

      const processStart = now();
      try {
        if (entry.action === 'unlink') {
          await this.handleDelete(repoId, entry.relativePath);
          stats.deleted += 1;
          this.logStructured({
            event: 'watch',
            repoId,
            filePath: relPath,
            action: 'unlink',
            reason: 'file-removed',
            durationMs: now() - processStart,
            queueDepth: pending.size,
          });
        } else {
          const outcome = await this.handleChange(
            repoId,
            entry.absolutePath,
            entry.relativePath,
            entry.action,
            opts,
          );
          if (outcome === 'skipped') stats.skipped += 1;
          else stats.processed += 1;
          this.logStructured({
            event: 'watch',
            repoId,
            filePath: relPath,
            action: entry.action,
            reason: outcome,
            durationMs: now() - processStart,
            queueDepth: pending.size,
          });
        }
        stats.lastProcessedAt = now();
        this.metrics?.inc('coderover_watch_events_total', {
          repoId,
          action: entry.action,
        });
        this.metrics?.observe(
          'coderover_watch_processing_seconds',
          (now() - processStart) / 1000,
          { action: entry.action },
        );
        recordLagGauge();
      } catch (err) {
        this.logger.warn(
          `watch handler failed for ${relPath}: ${(err as Error).message}`,
        );
      }
    };

    const enqueue = (action: WatchAction, absolutePath: string) => {
      const relativePath = toPosixRelative(absolute, absolutePath);
      if (ignoreMatcher(relativePath)) return;

      stats.events += 1;
      stats.lastEventAt = now();

      const prior = pending.get(relativePath);
      if (prior?.timer) clearTimeout(prior.timer);
      const firstSeenAt = prior?.firstSeenAt ?? now();

      // eslint-disable-next-line prefer-const
      let timer: NodeJS.Timeout;
      const entry: PendingEntry = {
        action,
        absolutePath,
        relativePath,
        firstSeenAt,
        lastSeenAt: now(),
        timer: null,
      };
      timer = setTimeout(() => {
        void flushPath(relativePath);
      }, debounceMs);
      // `.unref()` keeps Node's event loop free to exit on SIGINT.
      if (typeof timer.unref === 'function') timer.unref();
      entry.timer = timer;
      pending.set(relativePath, entry);
      recordQueueGauge();

      if (verbose) {
        this.logStructured({
          event: 'watch-enqueue',
          repoId,
          filePath: relativePath,
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
          this.logger.error(`watcher error: ${err.message}`);
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
      {
        ignore: [
          '.git',
          'node_modules',
          'dist',
          'build',
          '.next',
          'target',
          '__pycache__',
          '.coderover-cache',
        ],
      },
    );

    this.logger.log(
      `watch daemon started: repoId=${repoId} root=${absolute} debounceMs=${debounceMs}`,
    );

    const flush = async () => {
      // Fire every queued debounce immediately.
      const paths = [...pending.keys()];
      for (const p of paths) {
        const entry = pending.get(p);
        if (entry?.timer) clearTimeout(entry.timer);
        await flushPath(p);
      }
    };

    const stop = async (): Promise<WatchStats> => {
      stopping = true;
      try {
        await subscription.unsubscribe();
      } catch (err) {
        this.logger.warn(`unsubscribe failed: ${(err as Error).message}`);
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

  private async handleChange(
    repoId: string,
    absolutePath: string,
    relativePath: string,
    action: WatchAction,
    opts: WatchOptions,
  ): Promise<'processed' | 'skipped' | 'observe-only'> {
    if (!opts.processFnFactory || !this.incremental) {
      // Observe-only mode: the daemon sees the event but we never
      // call the ingest pipeline. Intentional — see service header.
      return 'observe-only';
    }
    let content: string;
    try {
      content = fs.readFileSync(absolutePath, 'utf8');
    } catch (err) {
      this.logger.warn(
        `failed to read ${relativePath}: ${(err as Error).message}`,
      );
      return 'skipped';
    }
    const processFn = opts.processFnFactory({
      repoId,
      absolutePath,
      relativePath,
      action,
    });
    const runId = `watch:${repoId}`;
    const result = await this.incremental.processFileIfChanged(
      runId,
      repoId,
      relativePath,
      content,
      processFn,
    );
    return result.action === 'processed' ? 'processed' : 'skipped';
  }

  private async handleDelete(
    repoId: string,
    relativePath: string,
  ): Promise<void> {
    if (!this.incremental) return;
    await this.incremental.applyDeletes(repoId, [relativePath]);
  }

  private logStructured(payload: Record<string, unknown>): void {
    this.logger.log(JSON.stringify(payload));
  }
}

function toPosixRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

/**
 * Lazy-load `@parcel/watcher` so tests that inject a mock backend
 * don't pay the native-module load cost, and so the CLI works on
 * platforms where the native binary isn't installed (it falls back
 * with a clear error message).
 */
async function loadParcelBackend(): Promise<WatcherBackend> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = await import('@parcel/watcher');
  return {
    subscribe: async (rootPath, onEvents, opts) => {
      const sub = await mod.subscribe(
        rootPath,
        (err, events) => onEvents(err, events as RawFsEvent[]),
        { ignore: opts.ignore },
      );
      return { unsubscribe: () => sub.unsubscribe() };
    },
  };
}
