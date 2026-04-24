/**
 * Phase 10 C5 — watch-latency benchmark.
 *
 * What it measures: end-to-end latency from a filesystem event
 * arriving at WatchDaemonService → the daemon's `stats.processed`
 * counter incrementing. That latency is dominated by the debounce
 * window, plus whatever overhead the queue + handler add.
 *
 * Why it matters: Phase 10 C3 ships a 500ms-default debounce. We want
 * to confirm the real p50/p95 observed latency is bounded:
 *   - p50 < debounce + ~100ms
 *   - p95 < debounce + ~500ms
 *
 * ### What this benchmark does
 *
 *   1. Start a WatchDaemonService in observe-only mode (no
 *      IncrementalIngestService wired — the daemon debounces, logs,
 *      and bumps stats, but never calls the ingest pipeline).
 *   2. Fire N synthetic `update` events through a mock
 *      `watcherBackend` (the same pattern the spec uses — bypasses
 *      real FS jitter).
 *   3. After each event, poll `handle.stats()` until `processed`
 *      increments. Record elapsed wall time.
 *   4. Compute p50/p95/p99, print markdown table, exit non-zero if
 *      p95 exceeds the threshold.
 *
 * ### Determinism
 *
 * FS timing is inherently noisy but the mock backend removes that
 * source of jitter. What we're left with measuring is:
 *   - `setTimeout` dispatch precision (~1-15ms on most Node runtimes)
 *   - promise microtask draining
 *   - Map lookups + small object allocations
 *
 * Events are fired sequentially with a small gap so each path has its
 * own debounce window — we want to see per-event latency, not the
 * coalescing behavior (that has dedicated unit tests).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  WatchDaemonService,
  WatcherBackend,
  RawFsEvent,
} from '../src/ingest/watch-daemon.service';
import { formatTable, summarize } from './_harness';

const EVENT_COUNT = 100;
const FILE_POOL = 20;
const DEBOUNCE_MS = 500;
// Threshold gate on the end-to-end p95. 500ms debounce + ~500ms slack
// keeps us honest about regressions without being flaky on a loaded
// CI machine.
const MAX_P95_MS = 1000;
// Safety net — any single event taking longer than this means we've
// dropped a `processed` increment somewhere. Fail fast rather than
// hang the benchmark.
const PER_EVENT_TIMEOUT_MS = 5000;

/**
 * Mock watcher backend — same shape as the spec's. `emit` lets the
 * benchmark push synthetic events to the subscribed handler.
 */
function makeMockBackend(): {
  backend: WatcherBackend;
  emit: (events: RawFsEvent[]) => void;
} {
  let handler: ((err: Error | null, events: RawFsEvent[]) => void) | null = null;
  const backend: WatcherBackend = {
    subscribe: async (_root, onEvents, _opts) => {
      handler = onEvents;
      return { unsubscribe: async () => {} };
    },
  };
  return {
    backend,
    emit: (events) => {
      if (handler) handler(null, events);
    },
  };
}

/** Resolve once stats.processed reaches `target`, or reject on timeout. */
function waitForProcessed(
  stats: () => { processed: number },
  target: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (stats().processed >= target) return resolve();
      if (Date.now() > deadline) {
        return reject(
          new Error(
            `watch-latency: processed stuck at ${stats().processed}, expected ${target}`,
          ),
        );
      }
      setImmediate(tick);
    };
    tick();
  });
}

async function main(): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-watch-'));

  try {
    // Seed a pool of real files so the daemon's ignore/relative-path
    // machinery has honest input. We won't actually modify these; the
    // events we fire are synthetic.
    for (let i = 0; i < FILE_POOL; i++) {
      fs.writeFileSync(
        path.join(tmpRoot, `file${i}.ts`),
        `export const x${i} = ${i};\n`,
        'utf8',
      );
    }

    const { backend, emit } = makeMockBackend();
    const daemon = new WatchDaemonService();
    const handle = await daemon.start('bench-repo', tmpRoot, {
      watcherBackend: backend,
      debounceMs: DEBOUNCE_MS,
      // observe-only — no processFnFactory, so handleChange returns
      // 'observe-only' and stats.processed still ticks (by design,
      // see WatchDaemonService header).
    });

    const samples: number[] = [];
    try {
      for (let i = 0; i < EVENT_COUNT; i++) {
        const fileIdx = i % FILE_POOL;
        const target = path.join(tmpRoot, `file${fileIdx}.ts`);
        const expectedProcessed = handle.stats().processed + 1;

        const start = performance.now();
        emit([{ type: 'update', path: target }]);
        await waitForProcessed(() => handle.stats(), expectedProcessed, PER_EVENT_TIMEOUT_MS);
        const elapsed = performance.now() - start;
        samples.push(elapsed);
      }
    } finally {
      await handle.stop();
    }

    const stats = summarize(samples);

    const headers = ['scenario', 'events', 'debounce ms', 'p50 ms', 'p95 ms', 'p99 ms'];
    const rows = [
      [
        'watch_latency',
        String(samples.length),
        String(DEBOUNCE_MS),
        stats.p50.toFixed(2),
        stats.p95.toFixed(2),
        stats.p99.toFixed(2),
      ],
    ];

    console.log('');
    console.log(formatTable(headers, rows));
    console.log('');
    console.log(
      `mean=${stats.mean.toFixed(2)}ms  min=${stats.min.toFixed(2)}ms  max=${stats.max.toFixed(2)}ms`,
    );
    console.log('');

    if (stats.p95 > MAX_P95_MS) {
      console.error(`FAIL: p95 ${stats.p95.toFixed(2)}ms > ${MAX_P95_MS}ms`);
      process.exitCode = 1;
      return;
    }
    console.log('PASS');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
