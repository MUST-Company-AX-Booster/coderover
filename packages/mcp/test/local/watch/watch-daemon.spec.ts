/**
 * Watch daemon tests — Phase 11 Wave 4 L16.
 *
 * Injects a fake `watcherBackend` so the real `@parcel/watcher` is
 * never touched. The DB is an in-tmpdir SQLite file so sqlite-vec can
 * load; tests that don't need the AST pipeline run unconditionally.
 * Tests that drive an `add`/`change` event (which calls `indexFile` →
 * tree-sitter) are gated behind `TS_REAL=1` to match the Wave 2/3
 * suite's tree-sitter-flake avoidance.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import Database from 'better-sqlite3';

import {
  startWatch,
  type RawFsEvent,
  type WatcherBackend,
  type WatcherSubscription,
} from '../../../src/local/watch/watch-daemon';
import { openDb } from '../../../src/local/db/open';
import { migrate } from '../../../src/local/db/migrator';
import { migration001Initial } from '../../../src/local/db/migrations/001_initial';
import { migration002SqliteVec } from '../../../src/local/db/migrations/002_sqlite_vec';
import { migration003CallEdges } from '../../../src/local/db/migrations/003_call_edges';
import { loadSqliteVec } from '../../../src/local/db/sqlite-vec';
import { MockEmbedder } from '../../../src/local/embed/embedder';
import { treeSitterAvailable } from '../../helpers/tree-sitter-singleton';

type EventCallback = (err: Error | null, events: RawFsEvent[]) => void;

/**
 * Fake watcher backend. Tests call `fireEvent` after subscribe to
 * drive events without touching the filesystem watcher.
 */
class FakeBackend implements WatcherBackend {
  public subscribedRoot: string | null = null;
  public ignorePatterns: string[] = [];
  public unsubscribeCalls = 0;
  private cb: EventCallback | null = null;

  async subscribe(
    rootPath: string,
    onEvents: EventCallback,
    opts: { ignore: string[] },
  ): Promise<WatcherSubscription> {
    this.subscribedRoot = rootPath;
    this.ignorePatterns = opts.ignore;
    this.cb = onEvents;
    return {
      unsubscribe: async () => {
        this.unsubscribeCalls += 1;
      },
    };
  }

  fireEvent(ev: RawFsEvent): void {
    if (!this.cb) throw new Error('FakeBackend: fireEvent before subscribe');
    this.cb(null, [ev]);
  }
}

async function openTestDb(): Promise<{ db: Database.Database; cleanup: () => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-watch-'));
  const dbPath = path.join(dir, 'local.db');
  const db = openDb(dbPath);
  await migrate(db, [
    migration001Initial,
    migration002SqliteVec,
    migration003CallEdges,
  ]);
  loadSqliteVec(db);
  return {
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedRepo(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-watch-repo-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function flushMicro(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const describeIfTs = treeSitterAvailable() ? describe : describe.skip;

describe('startWatch (no tree-sitter required)', () => {
  it('throws on a missing rootPath', async () => {
    await expect(
      startWatch({
        db: new Database(':memory:'),
        embedder: new MockEmbedder(),
        rootPath: '/definitely/not/a/path/xyzzy',
        watcherBackend: new FakeBackend(),
      }),
    ).rejects.toThrow(/path not found/);
  });

  it('debounces rapid successive events into one fire (collapsed)', async () => {
    jest.useFakeTimers();
    const { db, cleanup: closeDb } = await openTestDb();
    const { root, cleanup: rmRoot } = seedRepo({
      'src/a.ts': 'export function a(){ return 1 }\n',
    });
    try {
      const backend = new FakeBackend();
      const handle = await startWatch({
        db,
        embedder: new MockEmbedder(),
        rootPath: root,
        debounceMs: 100,
        watcherBackend: backend,
      });

      const abs = path.join(root, 'src/a.ts');
      backend.fireEvent({ type: 'delete', path: abs });
      await jest.advanceTimersByTimeAsync(50);
      backend.fireEvent({ type: 'delete', path: abs });
      await jest.advanceTimersByTimeAsync(50);
      backend.fireEvent({ type: 'delete', path: abs });
      // Advance past the final debounce window and drain microtasks.
      await jest.advanceTimersByTimeAsync(150);
      // Switch back to real timers so flush's internal awaits (fs, db) resolve.
      jest.useRealTimers();
      await handle.flush();

      expect(handle.stats().events).toBe(3); // 3 raw
      expect(handle.stats().debounced).toBe(1); // 1 fire

      await handle.stop();
    } finally {
      jest.useRealTimers();
      rmRoot();
      closeDb();
    }
  });

  it('handles unlink by calling removeFile and recording deleted counter', async () => {
    const { db, cleanup: closeDb } = await openTestDb();
    const { root, cleanup: rmRoot } = seedRepo({
      'src/a.ts': 'export function a(){ return 1 }\n',
    });
    try {
      // Pre-seed DB with a row for src/a.ts so we can observe deletion.
      db.prepare(
        `INSERT INTO code_chunks (id, file_path, line_start, line_end, content, language, content_hash)
         VALUES ('cid', ?, 1, 1, 'x', 'typescript', ?)`,
      ).run('src/a.ts', 'h'.repeat(64));
      db.prepare(
        `INSERT INTO file_hashes (file_path, sha256, indexed_at) VALUES (?, ?, ?)`,
      ).run('src/a.ts', 'h'.repeat(64), Date.now());

      const backend = new FakeBackend();
      const events: string[] = [];
      const handle = await startWatch({
        db,
        embedder: new MockEmbedder(),
        rootPath: root,
        // Huge debounce so we rely on flush/stop to force the fire.
        debounceMs: 10_000,
        watcherBackend: backend,
        onEvent: (e) => events.push(e.action),
      });

      backend.fireEvent({ type: 'delete', path: path.join(root, 'src/a.ts') });
      expect(handle.stats().queueDepth).toBe(1);

      const stats = await handle.stop();
      expect(backend.unsubscribeCalls).toBe(1);
      expect(stats.deleted).toBe(1);
      expect(events).toContain('unlink');

      const remaining = (
        db.prepare('SELECT COUNT(*) as c FROM code_chunks WHERE file_path = ?').get(
          'src/a.ts',
        ) as { c: number }
      ).c;
      expect(remaining).toBe(0);
    } finally {
      rmRoot();
      closeDb();
    }
  });

  it('stop() flushes pending + unsubscribes even with a huge debounce window', async () => {
    const { db, cleanup: closeDb } = await openTestDb();
    const { root, cleanup: rmRoot } = seedRepo({
      'src/a.ts': 'export function a(){ return 1 }\n',
    });
    try {
      const backend = new FakeBackend();
      const events: string[] = [];
      const handle = await startWatch({
        db,
        embedder: new MockEmbedder(),
        rootPath: root,
        debounceMs: 10_000,
        watcherBackend: backend,
        onEvent: (e) => events.push(e.filePath),
      });

      backend.fireEvent({ type: 'delete', path: path.join(root, 'src/a.ts') });
      expect(handle.stats().queueDepth).toBe(1);

      const stats = await handle.stop();
      expect(backend.unsubscribeCalls).toBe(1);
      expect(stats.debounced).toBe(1);
      expect(events).toEqual(['src/a.ts']);
    } finally {
      rmRoot();
      closeDb();
    }
  });

  it('stats() returns monotonically increasing counters', async () => {
    const { db, cleanup: closeDb } = await openTestDb();
    const { root, cleanup: rmRoot } = seedRepo({
      'src/a.ts': 'export function a(){ return 1 }\n',
    });
    try {
      const backend = new FakeBackend();
      const handle = await startWatch({
        db,
        embedder: new MockEmbedder(),
        rootPath: root,
        debounceMs: 10_000,
        watcherBackend: backend,
      });

      backend.fireEvent({ type: 'delete', path: path.join(root, 'src/a.ts') });
      const before = handle.stats().events;
      backend.fireEvent({ type: 'delete', path: path.join(root, 'src/a.ts') });
      const after = handle.stats().events;
      expect(after).toBeGreaterThan(before);

      await handle.stop();
    } finally {
      rmRoot();
      closeDb();
    }
  });

  it('ignored paths (node_modules) never enqueue', async () => {
    const { db, cleanup: closeDb } = await openTestDb();
    const { root, cleanup: rmRoot } = seedRepo({
      'src/a.ts': 'export function a(){ return 1 }\n',
      'node_modules/dep/index.js': 'module.exports = 1;\n',
    });
    try {
      const backend = new FakeBackend();
      const handle = await startWatch({
        db,
        embedder: new MockEmbedder(),
        rootPath: root,
        debounceMs: 10_000,
        watcherBackend: backend,
      });

      backend.fireEvent({
        type: 'update',
        path: path.join(root, 'node_modules/dep/index.js'),
      });
      expect(handle.stats().events).toBe(0);
      expect(handle.stats().queueDepth).toBe(0);

      await handle.stop();
    } finally {
      rmRoot();
      closeDb();
    }
  });
});

describeIfTs('startWatch (real tree-sitter)', () => {
  it('fires a create event and calls indexFile on flush', async () => {
    const { db, cleanup: closeDb } = await openTestDb();
    const { root, cleanup: rmRoot } = seedRepo({
      'src/a.ts': 'export function a(){ return 1 }\n',
    });
    try {
      const backend = new FakeBackend();
      const events: Array<{ filePath: string; action: string; skipped: boolean }> = [];
      const handle = await startWatch({
        db,
        embedder: new MockEmbedder(),
        rootPath: root,
        // Big debounce — we drive processing via `flush()` so we don't
        // race with the real timer.
        debounceMs: 10_000,
        watcherBackend: backend,
        onEvent: (e) =>
          events.push({ filePath: e.filePath, action: e.action, skipped: e.skipped }),
      });

      backend.fireEvent({ type: 'create', path: path.join(root, 'src/a.ts') });
      expect(handle.stats().events).toBe(1);
      expect(handle.stats().queueDepth).toBe(1);

      await handle.flush();

      expect(events.length).toBe(1);
      expect(events[0].filePath).toBe('src/a.ts');
      expect(events[0].action).toBe('add');
      expect(events[0].skipped).toBe(false);
      expect(handle.stats().processed).toBe(1);

      await handle.stop();
    } finally {
      rmRoot();
      closeDb();
    }
  });
});
