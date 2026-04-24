/**
 * `coderover-mcp doctor` — local-mode checks.
 *
 * Remote-mode doctor (in `../doctor.ts`) verifies the API URL + token +
 * backend version. Local mode has a disjoint set of failure modes:
 *   - DB file never created (user forgot `coderover index`)
 *   - schema out of date (older install wrote the DB, newer mcp running)
 *   - indexer stale (file_hashes drifted vs disk)
 *   - embedder misconfigured (OPENAI_API_KEY missing)
 *   - sqlite-vec not loadable (native binding platform mismatch)
 *
 * Keeping the two doctors separate lets the output be action-focused rather
 * than a giant union of all possible checks.
 *
 * Dependencies are injected (`deps` / `io`) so specs can exercise every
 * branch without the real better-sqlite3 / sqlite-vec native bindings.
 */

import { promises as fs } from 'fs';
import * as crypto from 'crypto';
import type { McpServerEntry } from '../../installer/types';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  /** 'warn' = yellow/soft-fail (still counts as ok for exit code, but rendered with "!"). */
  severity?: 'error' | 'warn';
  message: string;
  fix?: string;
}

export interface DoctorLocalReport {
  checks: DoctorCheck[];
  passing: boolean;
}

/** What we extract from the agent config to locate the DB. */
export interface InstalledLocalEntry {
  mode?: string;
  dbPath?: string;
  embedMode?: string;
}

/** Minimal handle over a better-sqlite3 DB. Matches what we actually use. */
export interface DbHandle {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

export interface DoctorLocalDeps {
  /**
   * Open a SQLite database. Default impl lazy-loads better-sqlite3 so tests
   * can inject a mock without the real native binding being installed or
   * functional.
   */
  openDb?: (p: string) => DbHandle;
  /**
   * Best-effort: try to load sqlite-vec into a DB. Returns an Error on
   * failure, undefined on success. Default impl lazy-loads `sqlite-vec` so
   * tests can skip it on platforms without the native binary.
   */
  tryLoadSqliteVec?: (db: DbHandle) => Error | undefined;
  /** Returns the SHA-256 hex of a file's contents. Default reads via fs. */
  hashFile?: (p: string) => Promise<string>;
  /** Returns file mtime / existence. Default uses fs.stat. */
  fileExists?: (p: string) => Promise<boolean>;
  /**
   * PRNG for sampling file_hashes. Deterministic in tests, `Math.random` in
   * prod. Returns 0 ≤ x < 1.
   */
  rand?: () => number;
  /**
   * Probe whether a module id can be resolved from @coderover/mcp's
   * perspective. Used by the `embedder-reachable` check for offline mode
   * to detect whether @xenova/transformers is installed (typically via
   * the @coderover/mcp-offline companion package). Default: `require.resolve`.
   */
  canResolveModule?: (id: string) => boolean;
}

export interface DoctorLocalOptions {
  /**
   * Either a pre-parsed entry (preferred) or a config path we should read.
   * When neither is supplied the first check fails cleanly.
   */
  entry?: InstalledLocalEntry | null;
  configPath?: string;
  readConfig?: (p: string) => Promise<InstalledLocalEntry | null>;
  env?: NodeJS.ProcessEnv;
}

export interface DoctorLocalIo {
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
}

/** Required schema tables. `code_chunks_vec` is virtual so we probe via sqlite_master. */
const REQUIRED_TABLES = [
  'code_chunks',
  'symbols',
  'imports',
  'code_chunks_vec',
];

/**
 * Run all local-mode checks. Returns the full report; callers decide
 * whether to render it (see `renderReport`) and what exit code to use.
 */
export async function doctorLocal(
  opts: DoctorLocalOptions = {},
  deps: DoctorLocalDeps = {},
  io: DoctorLocalIo = {},
): Promise<DoctorLocalReport> {
  const env = opts.env ?? process.env;
  const checks: DoctorCheck[] = [];

  // 1. mcp-registered
  const entry = await resolveEntry(opts);
  if (!entry) {
    checks.push({
      name: 'mcp-registered',
      ok: false,
      severity: 'error',
      message: 'no MCP entry found for CodeRover',
      fix: 'run `npx @coderover/mcp install <agent> --local`',
    });
    render(checks, io);
    return { checks, passing: false };
  }
  checks.push({
    name: 'mcp-registered',
    ok: true,
    message: 'MCP entry found',
  });

  // 2. mode-is-local
  if (entry.mode !== 'local') {
    checks.push({
      name: 'mode-is-local',
      ok: false,
      severity: 'error',
      message: `CODEROVER_MODE is "${entry.mode ?? 'unset'}", expected "local"`,
      fix: 'run `npx @coderover/mcp install <agent> --local`',
    });
    render(checks, io);
    return { checks, passing: false };
  }
  checks.push({
    name: 'mode-is-local',
    ok: true,
    message: 'CODEROVER_MODE=local',
  });

  // 3. db-exists
  const dbPath = entry.dbPath;
  if (!dbPath) {
    checks.push({
      name: 'db-exists',
      ok: false,
      severity: 'error',
      message: 'CODEROVER_LOCAL_DB is unset',
      fix: 're-run install with --local (or set --db-path)',
    });
    render(checks, io);
    return { checks, passing: false };
  }
  const fileExists = deps.fileExists ?? defaultFileExists;
  if (!(await fileExists(dbPath))) {
    checks.push({
      name: 'db-exists',
      ok: false,
      severity: 'error',
      message: `DB file not found: ${dbPath}`,
      fix: `run \`npx @coderover/mcp index\` to build the index`,
    });
    render(checks, io);
    return { checks, passing: false };
  }
  checks.push({
    name: 'db-exists',
    ok: true,
    message: dbPath,
  });

  // 4. db-schema
  let db: DbHandle | null = null;
  const openDb = deps.openDb ?? defaultOpenDb;
  try {
    db = openDb(dbPath);
  } catch (err) {
    checks.push({
      name: 'db-schema',
      ok: false,
      severity: 'error',
      message: `cannot open DB: ${errorMessage(err)}`,
      fix: 'delete the DB and re-run `coderover index`',
    });
    render(checks, io);
    return { checks, passing: false };
  }

  let schemaOk = true;
  const foundTables = new Set<string>();
  try {
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view')",
    ).all() as Array<{ name: string }>;
    for (const r of rows) foundTables.add(r.name);
    for (const t of REQUIRED_TABLES) {
      if (!foundTables.has(t)) {
        schemaOk = false;
        break;
      }
    }
  } catch (err) {
    checks.push({
      name: 'db-schema',
      ok: false,
      severity: 'error',
      message: `schema probe failed: ${errorMessage(err)}`,
      fix: 'delete the DB and re-run `coderover index`',
    });
    db.close();
    render(checks, io);
    return { checks, passing: false };
  }

  if (!schemaOk) {
    const missing = REQUIRED_TABLES.filter((t) => !foundTables.has(t));
    checks.push({
      name: 'db-schema',
      ok: false,
      severity: 'error',
      message: `missing tables: ${missing.join(', ')}`,
      fix: 'delete the DB and re-run `coderover index`',
    });
    db.close();
    render(checks, io);
    return { checks, passing: false };
  }
  checks.push({
    name: 'db-schema',
    ok: true,
    message: `found ${REQUIRED_TABLES.join(', ')}`,
  });

  // 5. index-non-empty
  let chunkCount = 0;
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM code_chunks').get() as
      | { n: number }
      | undefined;
    chunkCount = row?.n ?? 0;
  } catch (err) {
    checks.push({
      name: 'index-non-empty',
      ok: false,
      severity: 'error',
      message: `count query failed: ${errorMessage(err)}`,
    });
    db.close();
    render(checks, io);
    return { checks, passing: false };
  }
  if (chunkCount === 0) {
    checks.push({
      name: 'index-non-empty',
      ok: false,
      severity: 'error',
      message: 'code_chunks is empty',
      fix: 'run `npx @coderover/mcp index` first',
    });
  } else {
    checks.push({
      name: 'index-non-empty',
      ok: true,
      message: `${chunkCount} chunks`,
    });
  }

  // 6. file-hashes-fresh — sample up to 5 rows, compare sha256 vs disk.
  const hashFile = deps.hashFile ?? defaultHashFile;
  const rand = deps.rand ?? Math.random;
  try {
    const rows = db
      .prepare('SELECT file_path, sha256 FROM file_hashes')
      .all() as Array<{ file_path: string; sha256: string }>;
    if (rows.length === 0) {
      checks.push({
        name: 'file-hashes-fresh',
        ok: true,
        message: 'no file_hashes rows to sample',
      });
    } else {
      const sample = sampleUpTo(rows, 5, rand);
      let drifted = 0;
      let missing = 0;
      for (const r of sample) {
        if (!(await fileExists(r.file_path))) {
          missing++;
          continue;
        }
        let actual = '';
        try {
          actual = await hashFile(r.file_path);
        } catch {
          drifted++;
          continue;
        }
        if (actual !== r.sha256) drifted++;
      }
      if (drifted > 0 || missing > 0) {
        const parts: string[] = [];
        if (drifted > 0) parts.push(`${drifted} changed`);
        if (missing > 0) parts.push(`${missing} missing`);
        checks.push({
          name: 'file-hashes-fresh',
          ok: false,
          severity: 'warn',
          message: `${parts.join(', ')} of ${sample.length} sampled`,
          fix: 'run `npx @coderover/mcp watch` or re-index',
        });
      } else {
        checks.push({
          name: 'file-hashes-fresh',
          ok: true,
          message: `all ${sample.length} sampled files up to date`,
        });
      }
    }
  } catch (err) {
    checks.push({
      name: 'file-hashes-fresh',
      ok: false,
      severity: 'warn',
      message: `sample failed: ${errorMessage(err)}`,
    });
  }

  // 7. embedder-reachable — env only, no outbound calls.
  const embedMode = entry.embedMode ?? 'openai';
  if (embedMode === 'openai') {
    if (env.OPENAI_API_KEY) {
      checks.push({
        name: 'embedder-reachable',
        ok: true,
        message: 'OPENAI_API_KEY is set',
      });
    } else {
      checks.push({
        name: 'embedder-reachable',
        ok: false,
        severity: 'error',
        message: 'OPENAI_API_KEY is not set',
        fix: 'export OPENAI_API_KEY=sk-... or re-install with --embed mock',
      });
    }
  } else if (embedMode === 'mock') {
    checks.push({
      name: 'embedder-reachable',
      ok: true,
      message: 'mock embedder needs no credentials',
    });
  } else if (embedMode === 'offline') {
    // As of @coderover/mcp 0.3.0, @xenova/transformers is no longer
    // bundled — users install @coderover/mcp-offline to get it. Probe
    // the resolution chain here rather than waiting for the first
    // embed() call to fail with a runtime error.
    const canResolve = deps.canResolveModule ?? defaultCanResolveModule;
    if (canResolve('@xenova/transformers')) {
      checks.push({
        name: 'embedder-reachable',
        ok: true,
        message: 'offline embedder ready (@xenova/transformers resolves)',
      });
    } else {
      checks.push({
        name: 'embedder-reachable',
        ok: false,
        severity: 'error',
        message:
          '@xenova/transformers not resolvable — offline mode needs the ' +
          '@coderover/mcp-offline companion package (split out in 0.3.0)',
        fix: 'npm install @coderover/mcp-offline',
      });
    }
  } else {
    checks.push({
      name: 'embedder-reachable',
      ok: false,
      severity: 'error',
      message: `unknown embed mode: ${embedMode}`,
      fix: 're-install with --embed openai|offline|mock',
    });
  }

  // 8. sqlite-vec-loadable — actually try loading against the open DB.
  const tryLoad = deps.tryLoadSqliteVec ?? defaultTryLoadSqliteVec;
  const loadErr = tryLoad(db);
  if (loadErr) {
    checks.push({
      name: 'sqlite-vec-loadable',
      ok: false,
      severity: 'error',
      message: `sqlite-vec failed to load: ${loadErr.message}`,
      fix: 'reinstall @coderover/mcp or check platform support for sqlite-vec',
    });
  } else {
    checks.push({
      name: 'sqlite-vec-loadable',
      ok: true,
      message: 'native binding loaded',
    });
  }

  db.close();
  render(checks, io);
  return { checks, passing: !checks.some((c) => !c.ok && c.severity !== 'warn') };
}

/** Default: read a well-known JSON config shape. Callers may override. */
async function resolveEntry(
  opts: DoctorLocalOptions,
): Promise<InstalledLocalEntry | null> {
  if (opts.entry !== undefined) return opts.entry;
  if (!opts.configPath) return null;
  if (opts.readConfig) return opts.readConfig(opts.configPath);
  return defaultReadConfig(opts.configPath);
}

/** Read a JSON config (Claude Code / Cursor shape) and extract local env. */
export async function defaultReadConfig(
  p: string,
): Promise<InstalledLocalEntry | null> {
  try {
    const text = await fs.readFile(p, 'utf8');
    const doc = JSON.parse(text);
    const entry: McpServerEntry | undefined = doc?.mcpServers?.coderover;
    if (!entry) return null;
    return {
      mode: entry.env?.CODEROVER_MODE,
      dbPath: entry.env?.CODEROVER_LOCAL_DB,
      embedMode: entry.env?.CODEROVER_EMBED_MODE,
    };
  } catch {
    return null;
  }
}

async function defaultFileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function defaultHashFile(p: string): Promise<string> {
  const buf = await fs.readFile(p);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function defaultOpenDb(p: string): DbHandle {
  // Lazy require — only hit the native binding when no test override was
  // supplied.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { openDb } = require('../../local/db/open') as {
    openDb: (p: string) => DbHandle;
  };
  return openDb(p);
}

function defaultCanResolveModule(id: string): boolean {
  try {
    require.resolve(id);
    return true;
  } catch {
    return false;
  }
}

function defaultTryLoadSqliteVec(db: DbHandle): Error | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadSqliteVec } = require('../../local/db/sqlite-vec') as {
      loadSqliteVec: (db: DbHandle) => void;
    };
    loadSqliteVec(db);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function sampleUpTo<T>(items: readonly T[], n: number, rand: () => number): T[] {
  if (items.length <= n) return [...items];
  const pool = [...items];
  const out: T[] = [];
  while (out.length < n && pool.length > 0) {
    const idx = Math.floor(rand() * pool.length);
    out.push(pool.splice(idx, 1)[0]!);
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Render checks as `✓`/`✗`/`!` lines. ASCII only — no emoji. */
export function renderReport(
  report: DoctorLocalReport,
  io: DoctorLocalIo,
): void {
  render(report.checks, io);
}

function render(checks: readonly DoctorCheck[], io: DoctorLocalIo): void {
  const out = io.out;
  const err = io.err;
  if (!out && !err) return;
  for (const c of checks) {
    const mark = c.ok ? '✓' : c.severity === 'warn' ? '!' : '✗';
    const line = `  ${mark} ${c.name}: ${c.message}\n`;
    const stream = c.ok ? out : err ?? out;
    stream?.write(line);
    if (!c.ok && c.fix) {
      (err ?? out)?.write(`      fix: ${c.fix}\n`);
    }
  }
}
