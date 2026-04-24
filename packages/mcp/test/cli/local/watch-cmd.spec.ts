/**
 * `coderover watch` CLI tests — Phase 11 Wave 4 L17.
 *
 * Heavy dep injection: fake watcher backend, instant `waitForShutdown`,
 * tmpdir DB + MockEmbedder. Full-pipeline path is gated on TS_REAL=1
 * because the initial-index run calls `indexRepo` which needs tree-sitter.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';

import {
  runWatchCmd,
  parseWatchArgs,
  helpText,
} from '../../../src/cli/local/watch-cmd';
import { openIndexedDb } from '../../../src/cli/local/shared';
import { MockEmbedder } from '../../../src/local/embed/embedder';
import type {
  RawFsEvent,
  WatcherBackend,
  WatcherSubscription,
} from '../../../src/local/watch/watch-daemon';
import { treeSitterAvailable } from '../../helpers/tree-sitter-singleton';

function captureStreams() {
  const out = new PassThrough();
  const err = new PassThrough();
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  out.on('data', (c: Buffer) => outChunks.push(c.toString()));
  err.on('data', (c: Buffer) => errChunks.push(c.toString()));
  return {
    out,
    err,
    outText: (): string => outChunks.join(''),
    errText: (): string => errChunks.join(''),
  };
}

class FakeBackend implements WatcherBackend {
  public ignorePatterns: string[] = [];
  public subscribeCount = 0;
  public unsubscribeCount = 0;
  async subscribe(
    _rootPath: string,
    _onEvents: (err: Error | null, events: RawFsEvent[]) => void,
    opts: { ignore: string[] },
  ): Promise<WatcherSubscription> {
    this.subscribeCount += 1;
    this.ignorePatterns = opts.ignore;
    return {
      unsubscribe: async () => {
        this.unsubscribeCount += 1;
      },
    };
  }
}

function seedRepo(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-watch-repo-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"tmp"}', 'utf8');
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function mkTmpDbPath(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-watch-db-'));
  return {
    dbPath: path.join(dir, 'local.db'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe('parseWatchArgs', () => {
  it('parses --debounce-ms', () => {
    expect(parseWatchArgs(['--debounce-ms', '100'])).toEqual({ debounceMs: 100 });
    expect(parseWatchArgs(['--debounce-ms=250'])).toEqual({ debounceMs: 250 });
  });

  it('parses positional path + verbose', () => {
    expect(parseWatchArgs(['/tmp/x', '--verbose'])).toEqual({
      path: '/tmp/x',
      verbose: true,
    });
  });

  it('rejects unknown flags', () => {
    expect(parseWatchArgs(['--ignore']).unknown).toMatch(/unknown flag/);
  });

  it('rejects a bad --debounce-ms value', () => {
    expect(parseWatchArgs(['--debounce-ms', 'abc']).unknown).toMatch(/non-negative/);
  });
});

describe('runWatchCmd — help and errors', () => {
  it('--help returns 0', async () => {
    const streams = captureStreams();
    const code = await runWatchCmd(['--help'], {
      stdout: streams.out,
      stderr: streams.err,
    });
    expect(code).toBe(0);
    expect(streams.outText()).toBe(helpText());
  });

  it('unknown flag returns exit 2', async () => {
    const streams = captureStreams();
    const code = await runWatchCmd(['--no-such-flag'], {
      stdout: streams.out,
      stderr: streams.err,
    });
    expect(code).toBe(2);
    expect(streams.errText()).toMatch(/unknown flag/);
  });
});

const describeIfTs = treeSitterAvailable() ? describe : describe.skip;

describeIfTs('runWatchCmd — full flow (real tree-sitter)', () => {
  it('runs initial index, starts daemon, and exits 0 on shutdown signal', async () => {
    const { root, cleanup: rmRoot } = seedRepo({
      'src/a.ts': 'export function alpha(){ return 1 }\n',
    });
    const { dbPath, cleanup: rmDb } = mkTmpDbPath();
    const backend = new FakeBackend();
    const streams = captureStreams();
    try {
      const code = await runWatchCmd([root, '--embed', 'mock', '--debounce-ms', '100'], {
        stdout: streams.out,
        stderr: streams.err,
        resolveDbPath: () => dbPath,
        resolveProjectRoot: (x) => x ?? root,
        buildEmbedder: () => new MockEmbedder(),
        openIndexedDb,
        watcherBackend: backend,
        // Resolve immediately — simulates SIGINT at the moment the daemon starts.
        waitForShutdown: async () => undefined,
      });
      expect(code).toBe(0);
      expect(backend.subscribeCount).toBe(1);
      expect(backend.unsubscribeCount).toBe(1);
      const txt = streams.outText();
      expect(txt).toMatch(/initial index/);
      expect(txt).toMatch(/daemon started/);
      // DB file was created.
      expect(fs.existsSync(dbPath)).toBe(true);
    } finally {
      rmDb();
      rmRoot();
    }
  });

  it('--debounce-ms is forwarded to the daemon', async () => {
    const { root, cleanup: rmRoot } = seedRepo({
      'src/a.ts': 'export function alpha(){ return 1 }\n',
    });
    const { dbPath, cleanup: rmDb } = mkTmpDbPath();
    const backend = new FakeBackend();
    const streams = captureStreams();
    try {
      const code = await runWatchCmd(
        [root, '--embed', 'mock', '--debounce-ms', '42'],
        {
          stdout: streams.out,
          stderr: streams.err,
          resolveDbPath: () => dbPath,
          resolveProjectRoot: (x) => x ?? root,
          buildEmbedder: () => new MockEmbedder(),
          openIndexedDb,
          watcherBackend: backend,
          waitForShutdown: async () => undefined,
        },
      );
      expect(code).toBe(0);
      expect(streams.outText()).toMatch(/debounce=42/);
    } finally {
      rmDb();
      rmRoot();
    }
  });
});
