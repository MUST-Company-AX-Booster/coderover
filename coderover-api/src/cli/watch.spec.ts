/**
 * Phase 10 C3 — CLI tests.
 *
 * Verifies the watch CLI's shape without booting a real Nest context:
 *   - argv forwarding (repoId, path, debounce default & override)
 *   - `--verbose` toggles the Nest logger config
 *   - SIGINT path calls `handle.stop()` and closes the container
 *   - missing required flags produce a non-zero exit code
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import {
  parseWatchArgs,
  runWatchCli,
  WatchArgParseError,
  CliIo,
} from './watch';

function makeIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: {
      write: (chunk: string | Buffer) => {
        out.push(chunk.toString());
        return true;
      },
    } as NodeJS.WritableStream,
    err: {
      write: (chunk: string | Buffer) => {
        err.push(chunk.toString());
        return true;
      },
    } as NodeJS.WritableStream,
  };
  return { io, out, err };
}

describe('parseWatchArgs', () => {
  it('parses path + repoId with debounce default of 500', () => {
    const parsed = parseWatchArgs(['/tmp/repo', '--repo-id', 'r1']);
    expect(parsed.path).toBe('/tmp/repo');
    expect(parsed.repoId).toBe('r1');
    expect(parsed.debounceMs).toBe(500);
    expect(parsed.verbose).toBe(false);
    expect(parsed.observeOnly).toBe(true);
  });

  it('accepts --debounce-ms override (space form)', () => {
    const parsed = parseWatchArgs(['/tmp/repo', '--repo-id', 'r1', '--debounce-ms', '250']);
    expect(parsed.debounceMs).toBe(250);
  });

  it('accepts --debounce-ms override (equals form)', () => {
    const parsed = parseWatchArgs(['/tmp/repo', '--repo-id=r1', '--debounce-ms=750']);
    expect(parsed.debounceMs).toBe(750);
    expect(parsed.repoId).toBe('r1');
  });

  it('sets verbose when --verbose is passed', () => {
    const parsed = parseWatchArgs(['/tmp/repo', '--repo-id', 'r1', '--verbose']);
    expect(parsed.verbose).toBe(true);
  });

  it('throws on unknown flag', () => {
    expect(() => parseWatchArgs(['/tmp/repo', '--nope'])).toThrow(WatchArgParseError);
  });

  it('throws on non-numeric debounce', () => {
    expect(() =>
      parseWatchArgs(['/tmp/repo', '--repo-id', 'r1', '--debounce-ms', 'abc']),
    ).toThrow(WatchArgParseError);
  });

  it('throws on missing value for --repo-id', () => {
    expect(() => parseWatchArgs(['/tmp/repo', '--repo-id'])).toThrow(WatchArgParseError);
  });

  it('records help flag', () => {
    const parsed = parseWatchArgs(['--help']);
    expect(parsed.help).toBe(true);
  });

  it('--enable-processor flips observeOnly + enableProcessor', () => {
    const parsed = parseWatchArgs(['/tmp/repo', '--repo-id', 'r', '--enable-processor']);
    expect(parsed.enableProcessor).toBe(true);
    expect(parsed.observeOnly).toBe(false);
  });
});

describe('runWatchCli', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-cli-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function fakeHandle() {
    const stop = jest.fn().mockResolvedValue({
      events: 0,
      debounced: 0,
      processed: 0,
      deleted: 0,
      skipped: 0,
      queueDepth: 0,
      lastEventAt: null,
      lastProcessedAt: null,
      pausedEvents: 0,
    });
    const stats = jest.fn().mockReturnValue({
      events: 0,
      debounced: 0,
      processed: 0,
      deleted: 0,
      skipped: 0,
      queueDepth: 0,
      lastEventAt: null,
      lastProcessedAt: null,
      pausedEvents: 0,
    });
    const flush = jest.fn().mockResolvedValue(undefined);
    return { stop, stats, flush };
  }

  function makeFakeContext(startSpy: jest.Mock) {
    const handle = fakeHandle();
    startSpy.mockResolvedValue(handle);
    const daemon = { start: startSpy };
    const close = jest.fn().mockResolvedValue(undefined);
    const ctx = {
      get: jest.fn().mockReturnValue(daemon),
      close,
    };
    return { ctx, daemon, handle, close };
  }

  /**
   * Kick off runWatchCli and resolve once it calls `onReady`, returning
   * both the exit-code promise and the signal handler that was installed.
   */
  async function startCli(
    argv: string[],
    extras: {
      io: CliIo;
      createContext: jest.Mock;
    },
  ): Promise<{
    code: Promise<number>;
    sendSignal: (sig: NodeJS.Signals) => void;
  }> {
    let signalHandler: ((sig: NodeJS.Signals) => void) | null = null;
    let codePromise!: Promise<number>;
    await new Promise<void>((resolveReady) => {
      codePromise = runWatchCli(argv, {
        io: extras.io,
        createContext: extras.createContext,
        installSignals: (h) => {
          signalHandler = h;
          return () => undefined;
        },
        onReady: () => resolveReady(),
      });
    });
    return {
      code: codePromise,
      sendSignal: (sig) => {
        if (signalHandler === null) {
          throw new Error('signal handler was never installed');
        }
        signalHandler(sig);
      },
    };
  }

  it('forwards repoId, resolved path, and default debounceMs to the daemon', async () => {
    const { io, out } = makeIo();
    const startSpy = jest.fn();
    const { ctx, handle, close } = makeFakeContext(startSpy);

    const { code, sendSignal } = await startCli(
      [tmpRoot, '--repo-id', 'repo-xyz'],
      { io, createContext: jest.fn().mockResolvedValue(ctx) },
    );

    expect(startSpy).toHaveBeenCalledTimes(1);
    const [repoIdArg, rootArg, optsArg] = startSpy.mock.calls[0]!;
    expect(repoIdArg).toBe('repo-xyz');
    expect(rootArg).toBe(path.resolve(tmpRoot));
    expect(optsArg.debounceMs).toBe(500);
    expect(optsArg.verbose).toBe(false);
    expect(optsArg.processFnFactory).toBeUndefined();

    expect(out.join('')).toContain('mode=observe-only');
    expect(out.join('')).toContain('repoId=repo-xyz');
    expect(out.join('')).toContain('debounce=500ms');

    sendSignal('SIGINT');
    const exitCode = await code;
    expect(exitCode).toBe(0);
    expect(handle.stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(out.join('')).toContain('final stats:');
  });

  it('honors --debounce-ms override', async () => {
    const { io } = makeIo();
    const startSpy = jest.fn();
    const { ctx } = makeFakeContext(startSpy);

    const { code, sendSignal } = await startCli(
      [tmpRoot, '--repo-id', 'r', '--debounce-ms', '123'],
      { io, createContext: jest.fn().mockResolvedValue(ctx) },
    );
    expect(startSpy.mock.calls[0]![2].debounceMs).toBe(123);
    sendSignal('SIGTERM');
    await code;
  });

  it('--verbose toggles the Nest logger config', async () => {
    const { io } = makeIo();
    const startSpy = jest.fn();
    const { ctx } = makeFakeContext(startSpy);
    const createContextVerbose = jest.fn().mockResolvedValue(ctx);

    const verbose = await startCli(
      [tmpRoot, '--repo-id', 'r', '--verbose'],
      { io, createContext: createContextVerbose },
    );
    expect(createContextVerbose).toHaveBeenCalledWith(['log', 'error', 'warn']);
    verbose.sendSignal('SIGINT');
    await verbose.code;

    const startSpy2 = jest.fn();
    const { ctx: ctx2 } = makeFakeContext(startSpy2);
    const createContextQuiet = jest.fn().mockResolvedValue(ctx2);
    const quiet = await startCli(
      [tmpRoot, '--repo-id', 'r'],
      { io, createContext: createContextQuiet },
    );
    expect(createContextQuiet).toHaveBeenCalledWith(['error', 'warn']);
    quiet.sendSignal('SIGINT');
    await quiet.code;
  });

  it('returns exit code 2 when --repo-id is missing', async () => {
    const { io, err } = makeIo();
    const code = await runWatchCli([tmpRoot], { io });
    expect(code).toBe(2);
    expect(err.join('')).toContain('--repo-id');
  });

  it('returns exit code 2 when path is missing', async () => {
    const { io, err } = makeIo();
    const code = await runWatchCli(['--repo-id', 'r'], { io });
    expect(code).toBe(2);
    expect(err.join('')).toContain('<path>');
  });

  it('returns exit code 2 when path does not exist', async () => {
    const { io, err } = makeIo();
    const code = await runWatchCli(
      [path.join(tmpRoot, 'does-not-exist'), '--repo-id', 'r'],
      { io },
    );
    expect(code).toBe(2);
    expect(err.join('')).toContain('path not found');
  });

  it('prints help and returns 0 on --help', async () => {
    const { io, out } = makeIo();
    const code = await runWatchCli(['--help'], { io });
    expect(code).toBe(0);
    expect(out.join('')).toContain('coderover watch');
  });

  it('--enable-processor wires processFnFactory + budgetGuard onto daemon.start', async () => {
    const { io, out } = makeIo();
    const startSpy = jest.fn();
    const handle = fakeHandle();
    startSpy.mockResolvedValue(handle);

    // The CLI does THREE `ctx.get()` lookups when --enable-processor
    // is set: daemon, WatchProcessorFactory, TokenCapService. We key
    // the fake container off the class name so each lookup returns
    // the right stub.
    const daemon = { start: startSpy };
    const processorFactory = { build: jest.fn().mockReturnValue(async () => ({ nodeIds: [] })) };
    const tokenCap = { check: jest.fn().mockResolvedValue({ ok: true }) };
    const close = jest.fn().mockResolvedValue(undefined);
    const ctx = {
      get: jest.fn().mockImplementation((token: any) => {
        const name = token?.name ?? String(token);
        if (name === 'WatchDaemonService') return daemon;
        if (name === 'WatchProcessorFactory') return processorFactory;
        if (name === 'TokenCapService') return tokenCap;
        throw new Error(`unexpected token: ${name}`);
      }),
      close,
    };

    const { code, sendSignal } = await startCli(
      [tmpRoot, '--repo-id', 'r', '--enable-processor'],
      { io, createContext: jest.fn().mockResolvedValue(ctx) },
    );

    expect(startSpy).toHaveBeenCalledTimes(1);
    const optsArg = startSpy.mock.calls[0]![2];
    expect(typeof optsArg.processFnFactory).toBe('function');
    expect(optsArg.budgetGuard).toBe(tokenCap);

    // The factory bridge invokes WatchProcessorFactory.build on each
    // changed file. Prove the wiring by calling it once.
    optsArg.processFnFactory({
      repoId: 'r',
      absolutePath: '/x/foo.ts',
      relativePath: 'foo.ts',
      action: 'change',
    });
    expect(processorFactory.build).toHaveBeenCalledWith({
      repoId: 'r',
      absolutePath: '/x/foo.ts',
      relativePath: 'foo.ts',
      action: 'change',
    });

    expect(out.join('')).toContain('mode=processing');

    sendSignal('SIGINT');
    const exitCode = await code;
    expect(exitCode).toBe(0);
    expect(close).toHaveBeenCalled();
  });
});
