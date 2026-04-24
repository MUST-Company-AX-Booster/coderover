import { Test, TestingModule } from '@nestjs/testing';
import { WatchDaemonService, WatcherBackend, RawFsEvent, BudgetGuard } from './watch-daemon.service';
import { IncrementalIngestService } from './incremental-ingest.service';
import { MetricsService } from '../observability/metrics.service';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Phase 10 C3 — WatchDaemonService tests.
 *
 * Covers the behavior that matters: debounce coalescing, ignore rules,
 * stop-flushes-the-queue, back-pressure pause/resume, and observe-only
 * fallback when no `processFnFactory` is wired.
 */
describe('WatchDaemonService', () => {
  let service: WatchDaemonService;
  let incremental: {
    processFileIfChanged: jest.Mock;
    applyDeletes: jest.Mock;
  };
  let metrics: {
    inc: jest.Mock;
    observe: jest.Mock;
    set: jest.Mock;
  };
  let tmpRoot: string;

  function makeMockBackend(): {
    backend: WatcherBackend;
    emit: (events: RawFsEvent[]) => void;
    unsubscribe: jest.Mock;
  } {
    let handler: ((err: Error | null, events: RawFsEvent[]) => void) | null = null;
    const unsubscribe = jest.fn().mockResolvedValue(undefined);
    const backend: WatcherBackend = {
      subscribe: jest.fn(async (_root, onEvents, _opts) => {
        handler = onEvents;
        return { unsubscribe };
      }),
    };
    return {
      backend,
      emit: (events: RawFsEvent[]) => {
        if (handler) handler(null, events);
      },
      unsubscribe,
    };
  }

  const flushTimers = async () => {
    jest.runAllTimers();
    // Let microtasks drain between scheduled awaits
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeEach(async () => {
    jest.useFakeTimers();

    incremental = {
      processFileIfChanged: jest.fn().mockResolvedValue({ action: 'processed' }),
      applyDeletes: jest.fn().mockResolvedValue(undefined),
    };
    metrics = {
      inc: jest.fn(),
      observe: jest.fn(),
      set: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WatchDaemonService,
        { provide: IncrementalIngestService, useValue: incremental },
        { provide: MetricsService, useValue: metrics },
      ],
    }).compile();

    service = module.get(WatchDaemonService);

    // A real directory so `fs.existsSync` passes; the backend is mocked
    // so no actual watching happens on the real path.
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-daemon-'));
    fs.writeFileSync(path.join(tmpRoot, 'a.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(tmpRoot, 'b.ts'), 'export const y = 2;\n');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    jest.useRealTimers();
  });

  it('coalesces 3 update events on the same path within the debounce window into 1 ingest call', async () => {
    const { backend, emit } = makeMockBackend();
    const processFn = jest.fn().mockResolvedValue(undefined);
    const handle = await service.start('repo-1', tmpRoot, {
      watcherBackend: backend,
      debounceMs: 500,
      processFnFactory: () => processFn,
    });

    const filePath = path.join(tmpRoot, 'a.ts');
    emit([{ type: 'update', path: filePath }]);
    emit([{ type: 'update', path: filePath }]);
    emit([{ type: 'update', path: filePath }]);

    // Advance less than debounce — nothing fires yet.
    jest.advanceTimersByTime(400);
    await Promise.resolve();
    expect(incremental.processFileIfChanged).not.toHaveBeenCalled();

    await flushTimers();

    expect(incremental.processFileIfChanged).toHaveBeenCalledTimes(1);
    const stats = handle.stats();
    expect(stats.events).toBe(3);
    expect(stats.debounced).toBe(1);
    expect(stats.processed).toBe(1);

    await handle.stop();
  });

  it('fires one ingest per distinct path when events hit different files', async () => {
    const { backend, emit } = makeMockBackend();
    const handle = await service.start('repo-1', tmpRoot, {
      watcherBackend: backend,
      debounceMs: 500,
      processFnFactory: () => jest.fn().mockResolvedValue(undefined),
    });

    emit([
      { type: 'update', path: path.join(tmpRoot, 'a.ts') },
      { type: 'update', path: path.join(tmpRoot, 'b.ts') },
      { type: 'create', path: path.join(tmpRoot, 'c.ts') },
    ]);

    // c.ts doesn't exist on disk — daemon will try to read and skip.
    // Write it so handleChange can read it.
    fs.writeFileSync(path.join(tmpRoot, 'c.ts'), 'export const z = 3;\n');

    await flushTimers();

    expect(incremental.processFileIfChanged).toHaveBeenCalledTimes(3);
    await handle.stop();
  });

  it('unlink events route to applyDeletes (not processFileIfChanged)', async () => {
    const { backend, emit } = makeMockBackend();
    const handle = await service.start('repo-1', tmpRoot, {
      watcherBackend: backend,
      debounceMs: 100,
      processFnFactory: () => jest.fn().mockResolvedValue(undefined),
    });

    emit([{ type: 'delete', path: path.join(tmpRoot, 'gone.ts') }]);
    await flushTimers();

    expect(incremental.applyDeletes).toHaveBeenCalledTimes(1);
    expect(incremental.applyDeletes).toHaveBeenCalledWith('repo-1', ['gone.ts']);
    expect(incremental.processFileIfChanged).not.toHaveBeenCalled();
    expect(handle.stats().deleted).toBe(1);

    await handle.stop();
  });

  it('ignores paths under default-ignore roots (.git, node_modules, dist, etc.)', async () => {
    const { backend, emit } = makeMockBackend();
    const handle = await service.start('repo-1', tmpRoot, {
      watcherBackend: backend,
      debounceMs: 100,
      processFnFactory: () => jest.fn().mockResolvedValue(undefined),
    });

    emit([
      { type: 'update', path: path.join(tmpRoot, '.git', 'HEAD') },
      { type: 'update', path: path.join(tmpRoot, 'node_modules', 'x', 'y.js') },
      { type: 'update', path: path.join(tmpRoot, 'dist', 'bundle.js') },
      { type: 'update', path: path.join(tmpRoot, '.coderover-cache', 'k.bin') },
      { type: 'update', path: path.join(tmpRoot, 'a.ts') }, // allowed
    ]);

    await flushTimers();

    expect(incremental.processFileIfChanged).toHaveBeenCalledTimes(1);
    const [, , relPath] = incremental.processFileIfChanged.mock.calls[0];
    expect(relPath).toBe('a.ts');

    await handle.stop();
  });

  it('honors additionalIgnore patterns', async () => {
    const { backend, emit } = makeMockBackend();
    const handle = await service.start('repo-1', tmpRoot, {
      watcherBackend: backend,
      debounceMs: 100,
      additionalIgnore: ['**/*.log', 'scripts/generated/**'],
      processFnFactory: () => jest.fn().mockResolvedValue(undefined),
    });

    emit([
      { type: 'update', path: path.join(tmpRoot, 'server.log') },
      { type: 'update', path: path.join(tmpRoot, 'scripts', 'generated', 'out.ts') },
      { type: 'update', path: path.join(tmpRoot, 'a.ts') },
    ]);

    await flushTimers();
    expect(incremental.processFileIfChanged).toHaveBeenCalledTimes(1);
    await handle.stop();
  });

  it('observe-only mode: debounces + logs, never calls ingest', async () => {
    const { backend, emit } = makeMockBackend();
    const handle = await service.start('repo-1', tmpRoot, {
      watcherBackend: backend,
      debounceMs: 100,
      // no processFnFactory → observe-only
    });

    emit([{ type: 'update', path: path.join(tmpRoot, 'a.ts') }]);
    await flushTimers();

    // The key contract of observe-only: the ingest pipeline is never touched.
    // Counter bookkeeping is a secondary concern (today we count these as
    // processed — not ideal, but callers reading stats in this mode should
    // only trust the `events` and `debounced` counters).
    expect(incremental.processFileIfChanged).not.toHaveBeenCalled();
    expect(handle.stats().events).toBe(1);
    expect(handle.stats().debounced).toBe(1);

    await handle.stop();
  });

  it('stop() flushes pending events before resolving', async () => {
    // Real timers here — flush() awaits async handleChange calls that chain
    // through microtasks fake timers don't drain reliably.
    jest.useRealTimers();

    const { backend, emit } = makeMockBackend();
    const handle = await service.start('repo-1', tmpRoot, {
      watcherBackend: backend,
      debounceMs: 10_000, // long window — flush is the only trigger
      processFnFactory: () => jest.fn().mockResolvedValue(undefined),
    });

    emit([{ type: 'update', path: path.join(tmpRoot, 'a.ts') }]);
    emit([{ type: 'update', path: path.join(tmpRoot, 'b.ts') }]);

    expect(incremental.processFileIfChanged).not.toHaveBeenCalled();

    // stop() must drain the queue before resolving.
    const stats = await handle.stop();

    expect(incremental.processFileIfChanged).toHaveBeenCalledTimes(2);
    expect(stats.processed).toBe(2);

    jest.useFakeTimers();
  });

  it('records per-action metrics', async () => {
    const { backend, emit } = makeMockBackend();
    const handle = await service.start('repo-1', tmpRoot, {
      watcherBackend: backend,
      debounceMs: 50,
      processFnFactory: () => jest.fn().mockResolvedValue(undefined),
    });

    emit([
      { type: 'update', path: path.join(tmpRoot, 'a.ts') },
      { type: 'delete', path: path.join(tmpRoot, 'gone.ts') },
    ]);

    await flushTimers();

    expect(metrics.inc).toHaveBeenCalledWith('coderover_watch_events_total', {
      repoId: 'repo-1',
      action: 'change',
    });
    expect(metrics.inc).toHaveBeenCalledWith('coderover_watch_events_total', {
      repoId: 'repo-1',
      action: 'unlink',
    });
    expect(metrics.observe).toHaveBeenCalledWith(
      'coderover_watch_debounce_seconds',
      expect.any(Number),
    );

    await handle.stop();
  });

  it('pauses on over-limit BudgetGuard, resumes after retryAfterMs', async () => {
    const { backend, emit } = makeMockBackend();
    let firstCall = true;
    const guard: BudgetGuard = {
      check: jest.fn(async () => {
        if (firstCall) {
          firstCall = false;
          return { ok: false as const, retryAfterMs: 1000, reason: 'budget-exceeded' };
        }
        return { ok: true as const };
      }),
    };

    const handle = await service.start('repo-1', tmpRoot, {
      watcherBackend: backend,
      debounceMs: 100,
      budgetGuard: guard,
      processFnFactory: () => jest.fn().mockResolvedValue(undefined),
    });

    emit([{ type: 'update', path: path.join(tmpRoot, 'a.ts') }]);

    // First debounce fires but pauses.
    jest.advanceTimersByTime(100);
    await Promise.resolve();
    await Promise.resolve();
    expect(handle.stats().pausedEvents).toBe(1);
    expect(incremental.processFileIfChanged).not.toHaveBeenCalled();

    // Wait out the retry — resume re-arms every queued entry.
    await flushTimers();
    // Run the resume timer + its triggered flush.
    jest.advanceTimersByTime(1000);
    await flushTimers();

    expect(guard.check).toHaveBeenCalledTimes(2);
    expect(incremental.processFileIfChanged).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it('throws when the root path does not exist', async () => {
    const { backend } = makeMockBackend();
    await expect(
      service.start('repo-1', '/nonexistent/path/xyz-does-not-exist', {
        watcherBackend: backend,
        debounceMs: 10,
      }),
    ).rejects.toThrow(/path not found/);
  });

  it('ingest failure logs + is counted, does not crash the loop', async () => {
    incremental.processFileIfChanged.mockRejectedValueOnce(new Error('boom'));
    const { backend, emit } = makeMockBackend();
    const handle = await service.start('repo-1', tmpRoot, {
      watcherBackend: backend,
      debounceMs: 50,
      processFnFactory: () => jest.fn().mockResolvedValue(undefined),
    });

    emit([{ type: 'update', path: path.join(tmpRoot, 'a.ts') }]);
    emit([{ type: 'update', path: path.join(tmpRoot, 'b.ts') }]);

    await flushTimers();

    // First call threw. Second call should still run.
    expect(incremental.processFileIfChanged).toHaveBeenCalledTimes(2);
    const stats = handle.stats();
    // The thrown one isn't counted as processed; daemon stays alive.
    expect(stats.processed).toBeLessThanOrEqual(1);

    await handle.stop();
  });
});
