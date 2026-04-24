/**
 * Sidecar metadata for local-mode SQLite indices.
 *
 * Each `~/.coderover/<sha>.db` may have a companion `<sha>.meta.json`
 * that records which project root the DB belongs to and when it was
 * first / last indexed. The sidecar is written by the `index`,
 * `reindex`, and `watch` commands via {@link touchMeta} and consumed
 * by `list` / `clean`.
 *
 * Why a sidecar and not a table inside the DB: reading it doesn't
 * require loading sqlite-vec, the native binding, or the better-sqlite3
 * module — so `coderover list` stays fast even across dozens of DBs
 * and works on machines where the native build is broken.
 *
 * Missing sidecar is always tolerated: older DBs (pre-meta) list as
 * `(unknown project)` and are never touched by `clean --orphans`. Only
 * DBs with a known, nonexistent `projectRoot` are treated as orphans.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface DbMeta {
  /** Absolute path to the project root this DB was built from. */
  projectRoot: string;
  /** Epoch ms when the meta was first written. */
  firstIndexedAt: number;
  /** Epoch ms of the most recent `touchMeta` call. */
  lastIndexedAt: number;
  /** Package version that last touched the meta. */
  writtenBy: string;
}

/**
 * Return the canonical sidecar path for a given DB path. Just swaps
 * the `.db` suffix for `.meta.json`; callers don't need to care about
 * the layout.
 */
export function metaPathFor(dbPath: string): string {
  if (dbPath.endsWith('.db')) {
    return `${dbPath.slice(0, -'.db'.length)}.meta.json`;
  }
  return `${dbPath}.meta.json`;
}

/** Read the sidecar for `dbPath`. Returns `null` if missing or malformed. */
export function readMeta(dbPath: string): DbMeta | null {
  const p = metaPathFor(dbPath);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DbMeta>;
    if (
      typeof parsed.projectRoot === 'string' &&
      typeof parsed.firstIndexedAt === 'number' &&
      typeof parsed.lastIndexedAt === 'number' &&
      typeof parsed.writtenBy === 'string'
    ) {
      return parsed as DbMeta;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write (or refresh) the sidecar for `dbPath`. Safe to call on every
 * index run — preserves `firstIndexedAt` when a prior sidecar exists
 * and only bumps `lastIndexedAt`. Never throws: failures just skip the
 * sidecar write and log to stderr, because a missing sidecar only
 * degrades `list` / `clean`, never indexing itself.
 */
export function touchMeta(
  dbPath: string,
  projectRoot: string,
  writtenBy?: string,
  now: number = Date.now(),
): void {
  const p = metaPathFor(dbPath);
  const prior = readMeta(dbPath);
  const next: DbMeta = {
    projectRoot,
    firstIndexedAt: prior?.firstIndexedAt ?? now,
    lastIndexedAt: now,
    writtenBy: writtenBy ?? resolvePackageVersion(),
  };
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[coderover] warning: failed to write DB meta: ${msg}\n`);
  }
}

/** Remove the sidecar for `dbPath`. Idempotent. */
export function removeMeta(dbPath: string): void {
  const p = metaPathFor(dbPath);
  try {
    fs.rmSync(p, { force: true });
  } catch {
    /* ignore */
  }
}

/** Lazy package-version lookup — mirrors `cli/index.ts::resolvePackageVersion`. */
function resolvePackageVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
