#!/usr/bin/env node
/**
 * Phase 10 C3 — `coderover watch <path>` CLI.
 *
 * A thin, user-facing shell around `WatchDaemonService`. Boots a Nest
 * application context (not a full HTTP app — we don't need the
 * controllers/pipes), resolves the daemon from the DI container, and
 * hands control to it. Prints a one-line banner and installs a SIGINT/
 * SIGTERM handler that drains the debounce queue, prints final stats,
 * and cleanly closes the container.
 *
 * Two modes, selected by `--enable-processor`:
 *
 *   - OBSERVE-ONLY (default): the daemon sees events and maintains
 *     stats but does not call the ingest pipeline. Safe for
 *     verifying the event loop without any DB/embedding side effects.
 *   - PROCESSING: `WatchProcessorFactory` wires a ProcessFn that
 *     re-chunks + re-embeds each changed file, and `TokenCapService`
 *     applies per-repo back-pressure. This is the real dev-loop
 *     re-indexing path.
 *
 * The implementation is deliberately dependency-free at the parse
 * layer (no yargs/commander) to match the style of
 * `packages/mcp/src/cli/args.ts`.
 */

import type { INestApplicationContext, LogLevel } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';

import type {
  WatchDaemonService,
  WatchHandle,
  WatchStats,
} from '../ingest/watch-daemon.service';
import type { WatchProcessorFactory } from '../ingest/watch-processor.factory';
import type { TokenCapService } from '../ingest/token-cap.service';

export interface CliIo {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
}

export interface ParsedWatchArgs {
  path: string;
  repoId: string;
  debounceMs: number;
  verbose: boolean;
  observeOnly: boolean;
  enableProcessor: boolean;
  help: boolean;
}

export class WatchArgParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchArgParseError';
  }
}

/**
 * Minimal argv parser. Grammar:
 *   coderover-watch <path> --repo-id <id> [--debounce-ms <n>] [--verbose]
 *                         [--observe-only] [--help]
 *
 * `argv` is expected to be `process.argv.slice(2)` — i.e. no node/script
 * prefix. Unknown flags throw; required flags throw when missing unless
 * `--help` was passed.
 */
export function parseWatchArgs(argv: string[]): ParsedWatchArgs {
  const out: ParsedWatchArgs = {
    path: '',
    repoId: '',
    debounceMs: 500,
    verbose: false,
    observeOnly: true,
    enableProcessor: false,
    help: false,
  };

  let positional: string | null = null;
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i]!;
    if (tok === '--help' || tok === '-h') {
      out.help = true;
      i += 1;
      continue;
    }
    if (tok === '--verbose') {
      out.verbose = true;
      i += 1;
      continue;
    }
    if (tok === '--observe-only') {
      out.observeOnly = true;
      out.enableProcessor = false;
      i += 1;
      continue;
    }
    if (tok === '--enable-processor') {
      out.enableProcessor = true;
      out.observeOnly = false;
      i += 1;
      continue;
    }
    if (tok === '--repo-id' || tok.startsWith('--repo-id=')) {
      const val = tok.includes('=') ? tok.slice('--repo-id='.length) : argv[++i];
      if (val === undefined || val === '' || val.startsWith('-')) {
        throw new WatchArgParseError('--repo-id requires a value');
      }
      out.repoId = val;
      i += 1;
      continue;
    }
    if (tok === '--debounce-ms' || tok.startsWith('--debounce-ms=')) {
      const val = tok.includes('=')
        ? tok.slice('--debounce-ms='.length)
        : argv[++i];
      if (val === undefined || val === '' || val.startsWith('-')) {
        throw new WatchArgParseError('--debounce-ms requires a value');
      }
      const parsed = Number(val);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new WatchArgParseError(
          `--debounce-ms must be a non-negative number (got "${val}")`,
        );
      }
      out.debounceMs = parsed;
      i += 1;
      continue;
    }
    if (tok.startsWith('-')) {
      throw new WatchArgParseError(`unknown flag ${tok}`);
    }
    if (positional !== null) {
      throw new WatchArgParseError(
        `unexpected positional argument "${tok}" (only one path is accepted)`,
      );
    }
    positional = tok;
    i += 1;
  }

  if (positional !== null) out.path = positional;
  return out;
}

export function helpText(): string {
  return [
    'coderover watch — filesystem watch daemon',
    '',
    'Usage:',
    '  coderover-watch <path> --repo-id <id> [options]',
    '',
    'Required:',
    '  <path>                Absolute or relative path to the repo root to watch',
    '  --repo-id <id>        Repo identifier to attribute events to',
    '',
    'Options:',
    '  --debounce-ms <n>     Debounce window per path in ms (default 500)',
    '  --verbose             Forward debounce-level events to logs',
    '  --observe-only        Run without touching the ingest pipeline (default)',
    '  --enable-processor    Wire IncrementalIngestService + TokenCapService so the',
    '                        daemon actually re-chunks and re-embeds on change',
    '  -h, --help            Show this help',
    '',
  ].join('\n');
}

/**
 * DI hooks — exposed so the spec can swap them out without actually
 * booting a Nest container. In production `createContext` is the real
 * `NestFactory.createApplicationContext(AppModule, ...)`.
 */
export interface WatchCliDeps {
  io?: CliIo;
  createContext?: (
    logger: false | LogLevel[],
  ) => Promise<INestApplicationContext>;
  installSignals?: (handler: (sig: NodeJS.Signals) => void) => () => void;
  /** Test-only: don't actually block the loop on the never-resolving promise. */
  awaitForever?: boolean;
  /**
   * Test-only hook invoked once the daemon is running and the signal
   * handler is installed. Tests can use this to drive shutdown
   * deterministically without racing against microtask queues.
   */
  onReady?: () => void;
}

/**
 * Run the CLI. Returns an intended exit code (so tests don't have to
 * spawn a subprocess). The shim bin is responsible for
 * `process.exit(code)`.
 */
export async function runWatchCli(
  argv: string[],
  deps: WatchCliDeps = {},
): Promise<number> {
  const io: CliIo = deps.io ?? { out: process.stdout, err: process.stderr };

  let parsed: ParsedWatchArgs;
  try {
    parsed = parseWatchArgs(argv);
  } catch (err) {
    io.err.write(`error: ${(err as Error).message}\n`);
    io.err.write(helpText());
    return 2;
  }

  if (parsed.help) {
    io.out.write(helpText());
    return 0;
  }

  if (!parsed.path) {
    io.err.write('error: <path> is required\n');
    io.err.write(helpText());
    return 2;
  }
  if (!parsed.repoId) {
    io.err.write('error: --repo-id is required\n');
    io.err.write(helpText());
    return 2;
  }

  const absPath = path.resolve(parsed.path);
  if (!fs.existsSync(absPath)) {
    io.err.write(`error: path not found: ${absPath}\n`);
    return 2;
  }

  const loggerConfig: false | LogLevel[] = parsed.verbose
    ? ['log', 'error', 'warn']
    : ['error', 'warn'];

  const createContext = deps.createContext ?? (async (logger) => {
    // Lazy import so unit tests that stub `deps.createContext` don't
    // incur the full Nest module graph load (and so that the file is
    // safe to import from test code without booting the app).
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('../app.module');
    return NestFactory.createApplicationContext(AppModule, {
      logger,
    });
  });

  let ctx: INestApplicationContext;
  try {
    ctx = await createContext(loggerConfig);
  } catch (err) {
    io.err.write(`error: failed to bootstrap Nest context: ${(err as Error).message}\n`);
    return 1;
  }

  let daemon: WatchDaemonService;
  try {
    // Resolve via runtime symbol lookup so the module ref is created
    // lazily (and testable via a fake context).
    const mod = await import('../ingest/watch-daemon.service');
    daemon = ctx.get(mod.WatchDaemonService);
  } catch (err) {
    io.err.write(`error: failed to resolve WatchDaemonService: ${(err as Error).message}\n`);
    await safeClose(ctx, io);
    return 1;
  }

  // Optional processor wiring — observe-only is the safe default.
  // Resolving these lazily (only when --enable-processor is set)
  // keeps observe-only immune to DI failures in ingest-only providers
  // (e.g. missing OPENAI_API_KEY for EmbedderService), which matters
  // for running the daemon in a sandbox just to verify the event loop.
  let processorFactory: WatchProcessorFactory | undefined;
  let tokenCap: TokenCapService | undefined;
  if (parsed.enableProcessor) {
    try {
      const processorMod = await import('../ingest/watch-processor.factory');
      const tokenCapMod = await import('../ingest/token-cap.service');
      processorFactory = ctx.get(processorMod.WatchProcessorFactory);
      tokenCap = ctx.get(tokenCapMod.TokenCapService);
    } catch (err) {
      io.err.write(
        `error: failed to resolve processor dependencies: ${(err as Error).message}\n`,
      );
      await safeClose(ctx, io);
      return 1;
    }
  }

  let handle: WatchHandle;
  try {
    handle = await daemon.start(parsed.repoId, absPath, {
      debounceMs: parsed.debounceMs,
      verbose: parsed.verbose,
      ...(processorFactory
        ? {
            processFnFactory: (fnArgs) => processorFactory!.build(fnArgs),
          }
        : {}),
      ...(tokenCap ? { budgetGuard: tokenCap } : {}),
    });
  } catch (err) {
    io.err.write(`error: failed to start watch daemon: ${(err as Error).message}\n`);
    await safeClose(ctx, io);
    return 1;
  }

  const mode = parsed.enableProcessor ? 'processing' : 'observe-only';
  io.out.write(
    `coderover watch — repoId=${parsed.repoId} root=${absPath} debounce=${parsed.debounceMs}ms mode=${mode}\n`,
  );

  // Shutdown wiring — draining the queue and closing the container
  // must be idempotent: SIGINT followed by SIGTERM (or two SIGINTs)
  // should not double-free.
  let shuttingDown = false;
  let shutdownResult: WatchStats | null = null;

  const shutdown = async (sig: NodeJS.Signals): Promise<number> => {
    if (shuttingDown) return 0;
    shuttingDown = true;
    io.out.write(`\nreceived ${sig}, shutting down...\n`);
    try {
      shutdownResult = await handle.stop();
    } catch (err) {
      io.err.write(`warn: handle.stop() failed: ${(err as Error).message}\n`);
      shutdownResult = handle.stats();
    }
    io.out.write(`final stats: ${JSON.stringify(shutdownResult)}\n`);
    await safeClose(ctx, io);
    return 0;
  };

  const installSignals =
    deps.installSignals ??
    ((handler) => {
      const onSig = (s: NodeJS.Signals) => {
        handler(s);
      };
      process.on('SIGINT', onSig);
      process.on('SIGTERM', onSig);
      return () => {
        process.off('SIGINT', onSig);
        process.off('SIGTERM', onSig);
      };
    });

  let resolveExit!: (code: number) => void;
  const exitPromise = new Promise<number>((r) => {
    resolveExit = r;
  });

  const uninstall = installSignals((sig) => {
    void shutdown(sig).then((code) => resolveExit(code));
  });

  if (deps.onReady) deps.onReady();

  // In test mode we return immediately so the test can exercise the
  // signal path synchronously.
  if (deps.awaitForever === false) {
    uninstall();
    return 0;
  }

  try {
    return await exitPromise;
  } finally {
    uninstall();
  }
}

async function safeClose(
  ctx: INestApplicationContext,
  io: CliIo,
): Promise<void> {
  try {
    await ctx.close();
  } catch (err) {
    io.err.write(`warn: ctx.close() failed: ${(err as Error).message}\n`);
  }
}

// When invoked directly (not imported as a library), run the CLI and
// map the promise to a process exit.
if (require.main === module) {
  runWatchCli(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      // Last-ditch — runWatchCli is expected to swallow its own errors.
      // eslint-disable-next-line no-console
      console.error('fatal:', err);
      process.exit(1);
    });
}
