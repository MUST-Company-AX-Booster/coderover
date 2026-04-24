/**
 * @coderover/mcp
 * ──────────────────────────────────────────────────────────────────────────────
 * Public entrypoint. Re-exports the building blocks for programmatic use
 * and exposes a `main()` that wires up either a remote (HTTP-backed) or
 * local (SQLite-backed) MCP server from environment variables.
 */

export * from './protocol';
export * from './transport/transport';
export * from './transport/http-client';
export * from './transport/remote-transport';
export * from './transport/capabilities-cache';
export * from './transport/local-transport';
export * from './server/server';
export * from './server/stdio';
export * from './installer/types';
export * from './installer/agents';
export { runCli } from './cli/index';

import type Database from 'better-sqlite3';

import { FetchHttpClient } from './transport/http-client';
import { RemoteTransport } from './transport/remote-transport';
import { CapabilitiesCache } from './transport/capabilities-cache';
import { LocalTransport } from './transport/local-transport';
import { McpServer } from './server/server';
import { StdioRunner } from './server/stdio';
import {
  buildEmbedder,
  openIndexedDb,
  type EmbedMode,
} from './cli/local/shared';

export type ServerMode = 'remote' | 'local';

export interface MainOptions {
  /** Force a mode; otherwise derived from `CODEROVER_MODE`. */
  mode?: ServerMode;
  apiUrl?: string;
  apiToken?: string;
  /** Local-mode DB path. Falls back to `CODEROVER_LOCAL_DB`. */
  dbPath?: string;
  /** Local-mode embedder. Falls back to `CODEROVER_EMBED_MODE`. */
  embedMode?: EmbedMode;
}

/**
 * Derive the server mode from options + env. Pure — exported for tests.
 *
 * `CODEROVER_MODE=local` is the signal the installer writes for `--local`
 * installs ([installer/agents/base.ts::buildLocalEntry]). Anything else
 * (including unset) means remote.
 */
export function resolveServerMode(opts: MainOptions = {}): ServerMode {
  if (opts.mode) return opts.mode;
  const env = (process.env.CODEROVER_MODE ?? '').trim().toLowerCase();
  return env === 'local' ? 'local' : 'remote';
}

/**
 * Boot an MCP server on stdio. Dispatches to the local or remote boot
 * path based on `resolveServerMode`. Used by `bin/coderover-mcp.js`.
 */
export async function main(opts: MainOptions = {}): Promise<void> {
  const mode = resolveServerMode(opts);
  if (mode === 'local') {
    await runLocalServer(opts);
  } else {
    await runRemoteServer(opts);
  }
}

/** Remote-mode boot: HTTP-backed `RemoteTransport`. */
async function runRemoteServer(opts: MainOptions): Promise<void> {
  const apiUrl = opts.apiUrl ?? process.env.CODEROVER_API_URL;
  const apiToken = opts.apiToken ?? process.env.CODEROVER_API_TOKEN;

  if (!apiUrl) {
    process.stderr.write(
      '[coderover-mcp] CODEROVER_API_URL is required for remote mode.\n' +
        '  Set it to your CodeRover API base URL, e.g. https://coderover.example.com\n' +
        '  Or run in local mode: CODEROVER_MODE=local CODEROVER_LOCAL_DB=<path>\n',
    );
    process.exit(2);
  }

  const http = new FetchHttpClient({ baseUrl: apiUrl, token: apiToken });
  const log = (msg: string): void => {
    process.stderr.write(`[coderover-mcp] ${msg}\n`);
  };
  const cache = new CapabilitiesCache();
  const transport = new RemoteTransport({ http, cache, apiUrl, log });
  const server = new McpServer({
    transport,
    log,
  });
  const runner = new StdioRunner({ server });

  process.on('SIGINT', () => runner.close());
  process.on('SIGTERM', () => runner.close());

  await runner.run();
}

/**
 * Local-mode boot: SQLite-backed `LocalTransport`.
 *
 * Reads the DB path from `CODEROVER_LOCAL_DB` (or `opts.dbPath`), opens
 * the indexed DB using the shared bootstrap (the same code path the
 * `index` / `reindex` / `watch` CLIs use), builds an embedder honouring
 * `CODEROVER_EMBED_MODE`, and constructs a `LocalTransport` wired for
 * live queries. Tool calls flow through to real SQLite/vec queries —
 * no fixtures.
 */
async function runLocalServer(opts: MainOptions): Promise<void> {
  const dbPath = opts.dbPath ?? process.env.CODEROVER_LOCAL_DB;
  if (!dbPath) {
    process.stderr.write(
      '[coderover-mcp] CODEROVER_LOCAL_DB is required for local mode.\n' +
        '  Build an index first:  npx @coderover/mcp index <path>\n' +
        '  Then re-run with CODEROVER_LOCAL_DB pointing at the resulting .db file.\n',
    );
    process.exit(2);
  }

  const embedder = buildEmbedder(opts.embedMode);

  let db: Database.Database;
  try {
    db = await openIndexedDb(dbPath, embedder.dimension);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[coderover-mcp] failed to open local index at ${dbPath}: ${msg}\n`,
    );
    process.exit(2);
  }

  const transport = new LocalTransport({ db, embedder });
  const server = new McpServer({
    transport,
    log: (msg) => process.stderr.write(`[coderover-mcp] ${msg}\n`),
  });
  const runner = new StdioRunner({ server });

  const shutdown = (): void => {
    runner.close();
    try {
      db.close();
    } catch {
      /* already closed */
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await runner.run();
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}
