/**
 * CLI dispatcher.
 *
 * The bin shim (`bin/coderover-mcp.js`) boots this module's `runCli()` with
 * `process.argv.slice(2)`. Commands:
 *   - no command (or `serve`): run the MCP server on stdio (legacy default).
 *   - install / uninstall / doctor / upgrade: the installer UX from A3.
 *
 * Exit codes are returned rather than thrown so tests can assert on them
 * without spawning a subprocess.
 */

import {
  parseArgs,
  ArgParseError,
  INSTALL_FLAGS,
  UNINSTALL_FLAGS,
  DOCTOR_FLAGS,
  UPGRADE_FLAGS,
  GLOBAL_FLAGS,
} from './args';
import { helpText } from './help';
import { runInstall } from './install';
import { runUninstall } from './uninstall';
import { runDoctor } from './doctor';
import { runUpgrade } from './upgrade';
import { runIndexCmd } from './local/index-cmd';
import { runReindexCmd } from './local/reindex-cmd';
import { runWatchCmd } from './local/watch-cmd';
import { runListCmd } from './local/list-cmd';
import { runCleanCmd } from './local/clean-cmd';
import { FetchHttpClient } from '../transport/http-client';
import { stdPromptIo } from './prompt';

export interface CliIo {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
  cwd: string;
  homeDir?: string;
}

/** Read this lazily so we don't blow up if the package.json moves. */
function resolvePackageVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Entry point. Returns the intended exit code; the shim is responsible for
 * calling `process.exit()`.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const packageVersion = resolvePackageVersion();

  // Peek at the first token to pick the flag set. We do an initial parse with
  // only global flags to handle the `--help` / `--version` / no-command case.
  const first = argv.find((a) => !a.startsWith('-')) ?? '';

  // Global fast paths.
  if (argv.includes('--help') || argv.includes('-h')) {
    if (first === '' || isKnownSub(first)) {
      io.out.write(helpText(packageVersion));
      return 0;
    }
  }
  if (argv.includes('--version') || argv.includes('-V')) {
    io.out.write(`${packageVersion}\n`);
    return 0;
  }

  // No command → run the server on stdio (legacy default).
  if (first === '' || first === 'serve') {
    const { main } = await import('../index');
    await main();
    return 0;
  }

  try {
    switch (first) {
      case 'install': {
        const parsed = parseArgs(argv, INSTALL_FLAGS);
        if (parsed.flags.help) {
          io.out.write(helpText(packageVersion));
          return 0;
        }
        const remote = Boolean(parsed.flags.remote);
        const local = Boolean(parsed.flags.local);
        if (remote && local) {
          io.err.write('--remote and --local are mutually exclusive.\n');
          return 1;
        }
        const res = await runInstall(
          {
            agents: parsed.positional,
            mode: local ? 'local' : 'remote',
            apiUrl: stringFlag(parsed.flags['api-url']),
            token: stringFlag(parsed.flags.token),
            dryRun: Boolean(parsed.flags['dry-run']),
          },
          {
            io: stdPromptIo(),
            out: io.out,
            err: io.err,
            env: io.env,
            homeDir: io.homeDir,
            cwd: io.cwd,
            makeHttp: (o) => new FetchHttpClient(o),
            packageVersion,
          },
        );
        return res.exitCode;
      }
      case 'uninstall': {
        const parsed = parseArgs(argv, UNINSTALL_FLAGS);
        if (parsed.flags.help) {
          io.out.write(helpText(packageVersion));
          return 0;
        }
        const res = await runUninstall(
          {
            agents: parsed.positional,
            dryRun: Boolean(parsed.flags['dry-run']),
          },
          { out: io.out, err: io.err, homeDir: io.homeDir },
        );
        return res.exitCode;
      }
      case 'doctor': {
        const parsed = parseArgs(argv, DOCTOR_FLAGS);
        if (parsed.flags.help) {
          io.out.write(helpText(packageVersion));
          return 0;
        }
        const res = await runDoctor(
          {
            agent: parsed.positional[0],
            apiUrl: stringFlag(parsed.flags['api-url']),
            token: stringFlag(parsed.flags.token),
          },
          {
            out: io.out,
            err: io.err,
            env: io.env,
            homeDir: io.homeDir,
            nodeVersion: process.versions.node,
            packageVersion,
            makeHttp: (o) => new FetchHttpClient(o),
          },
        );
        return res.exitCode;
      }
      case 'upgrade': {
        const parsed = parseArgs(argv, UPGRADE_FLAGS);
        if (parsed.flags.help) {
          io.out.write(helpText(packageVersion));
          return 0;
        }
        const res = await runUpgrade(
          {
            apiUrl: stringFlag(parsed.flags['api-url']),
            token: stringFlag(parsed.flags.token),
          },
          {
            out: io.out,
            err: io.err,
            env: io.env,
            homeDir: io.homeDir,
            packageVersion,
            makeHttp: (o) => new FetchHttpClient(o),
          },
        );
        return res.exitCode;
      }
      case 'index': {
        return runIndexCmd(argv.slice(argv.indexOf('index') + 1), {
          stdout: io.out,
          stderr: io.err,
        });
      }
      case 'reindex': {
        return runReindexCmd(argv.slice(argv.indexOf('reindex') + 1), {
          stdout: io.out,
          stderr: io.err,
        });
      }
      case 'watch': {
        return runWatchCmd(argv.slice(argv.indexOf('watch') + 1), {
          stdout: io.out,
          stderr: io.err,
        });
      }
      case 'list': {
        return runListCmd(argv.slice(argv.indexOf('list') + 1), {
          stdout: io.out,
          stderr: io.err,
          homeDir: io.homeDir,
        });
      }
      case 'clean': {
        return runCleanCmd(argv.slice(argv.indexOf('clean') + 1), {
          stdout: io.out,
          stderr: io.err,
          homeDir: io.homeDir,
        });
      }
      default: {
        // Gate on global flags to surface unknown-subcommand errors cleanly.
        parseArgs(argv, GLOBAL_FLAGS);
        io.err.write(`unknown command: ${first}\n`);
        io.err.write(helpText(packageVersion));
        return 1;
      }
    }
  } catch (err) {
    if (err instanceof ArgParseError) {
      io.err.write(`${err.message}\n`);
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    io.err.write(`[coderover-mcp] fatal: ${msg}\n`);
    return 1;
  }
}

function stringFlag(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function isKnownSub(s: string): boolean {
  // Note: index / reindex / watch are intentionally absent — their own
  // subcommands own a richer --help, so we let the dispatcher reach them
  // instead of short-circuiting to the top-level help here.
  return ['install', 'uninstall', 'doctor', 'upgrade', 'serve', ''].includes(s);
}
