/**
 * Phase 11 Wave 4 — L17: shared CLI bootstrap for the local-mode commands.
 *
 * Every `coderover <local-cmd>` invocation does the same four things:
 *
 *   1. Resolve the project root — walk up from the input path looking
 *      for a familiar manifest (`package.json`, `pyproject.toml`, …).
 *      Falling back to the input itself keeps the CLI usable on
 *      non-standard layouts.
 *   2. Resolve the SQLite DB path — `~/.coderover/<sha>.db`, keyed on
 *      the project root so two repos on the same machine never share
 *      a DB file.
 *   3. Build an embedder — real OpenAI adapter in production, the
 *      deterministic `MockEmbedder` under `CODEROVER_EMBED_MODE=mock`
 *      (default: try real, fall back to mock only if the real can't
 *      construct).
 *   4. Open + migrate the DB — two Wave-1 migrations, then
 *      `loadSqliteVec` so `code_chunks_vec` is usable immediately.
 *
 * Pulling these into one module means index / reindex / watch share
 * one bootstrap surface — fewer drift points between the three.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type Database from 'better-sqlite3';

import { openDb } from '../../local/db/open';
import { migrate } from '../../local/db/migrator';
import { migration001Initial } from '../../local/db/migrations/001_initial';
import { makeSqliteVecMigration } from '../../local/db/migrations/002_sqlite_vec';
import { migration003CallEdges } from '../../local/db/migrations/003_call_edges';
import { loadSqliteVec } from '../../local/db/sqlite-vec';

import type { Embedder } from '../../local/embed/types';
import { DEFAULT_OPENAI_DIMENSION } from '../../local/embed/types';
import { MockEmbedder, OpenAIEmbedder } from '../../local/embed/embedder';
import { OfflineEmbedder } from '../../local/embed/offline-embedder';

/** Manifest files that mark a project root, probed in order. */
const ROOT_MARKERS: string[] = [
  'package.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  '.git',
];

/**
 * Walk up from `inputPath` (or cwd) looking for a project-root marker.
 * Falls back to the input path itself — the user is usually running
 * from inside the repo anyway, and a stable "this directory is my
 * repo" signal avoids surprises when someone points us at a subtree.
 */
export function resolveProjectRoot(inputPath: string | undefined): string {
  const start = path.resolve(inputPath ?? process.cwd());

  // If the path doesn't exist, return it as-is; the caller will surface
  // a clear error when it tries to walk the tree.
  if (!fs.existsSync(start)) return start;

  // If the input is a file, begin the search from its parent directory.
  let cur = start;
  try {
    const stat = fs.statSync(start);
    if (!stat.isDirectory()) {
      cur = path.dirname(start);
    }
  } catch {
    // ignore — we already checked existence above, but a race is possible.
  }

  for (let i = 0; i < 64; i++) {
    for (const marker of ROOT_MARKERS) {
      if (fs.existsSync(path.join(cur, marker))) {
        return cur;
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return start;
}

/**
 * Resolve the on-disk path for the SQLite DB corresponding to
 * `projectRoot`. Lives under `~/.coderover/` — the same directory the
 * installer places its config under.
 *
 * Hash collisions are effectively impossible at the expected scale
 * (hundreds of projects per user at most) with 16 hex chars of SHA256.
 */
export function resolveDbPath(projectRoot: string): string {
  const sha = crypto
    .createHash('sha256')
    .update(path.resolve(projectRoot))
    .digest('hex')
    .slice(0, 16);
  const home = os.homedir();
  return path.join(home, '.coderover', `${sha}.db`);
}

/** CLI-level embedder modes. See {@link buildEmbedder}. */
export type EmbedMode = 'mock' | 'openai' | 'offline';

/**
 * Build an embedder honouring `CODEROVER_EMBED_MODE`:
 *
 *   - 'mock' → {@link MockEmbedder} (no network, deterministic vectors).
 *   - 'openai' (default) → {@link OpenAIEmbedder} using
 *     `OPENAI_API_KEY`. If the key is missing we fall back to mock with
 *     a warning on stderr — the CLI works out of the box with no key,
 *     matching the A3b demo-without-network promise.
 *   - 'offline' → {@link OfflineEmbedder} (Transformers.js + MiniLM,
 *     384-dim). Requires the optional `@xenova/transformers` dep; the
 *     embedder throws a clear install-hint error on first use if it's
 *     missing. Needs a DB indexed at dim 384 — mixing modes in the
 *     same DB is rejected by {@link openIndexedDb}.
 *
 * Accepts an explicit `mode` arg for the CLI's `--embed` flag; if
 * provided it wins over the env.
 */
export function buildEmbedder(mode?: EmbedMode): Embedder {
  const envMode = (process.env.CODEROVER_EMBED_MODE ?? '').toLowerCase();
  const resolved: EmbedMode =
    mode ??
    (envMode === 'mock'
      ? 'mock'
      : envMode === 'offline'
        ? 'offline'
        : envMode === 'openai'
          ? 'openai'
          : 'openai');

  if (resolved === 'mock') {
    return new MockEmbedder();
  }

  if (resolved === 'offline') {
    return new OfflineEmbedder();
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Graceful fallback — the CLI should work out of the box. The
    // message fires on stderr so plumbed-through scripts see it but
    // stdout stays parseable.
    process.stderr.write(
      '[coderover] OPENAI_API_KEY not set; falling back to MockEmbedder.\n' +
        '  Set CODEROVER_EMBED_MODE=mock to silence this warning.\n',
    );
    return new MockEmbedder();
  }

  return new OpenAIEmbedder({ apiKey });
}

/**
 * Read the dim of an already-created `code_chunks_vec` table, or
 * `undefined` if the table doesn't exist yet. We parse the stored
 * CREATE VIRTUAL TABLE statement in `sqlite_master` because vec0
 * virtual tables don't expose column types through `PRAGMA
 * table_info()` the way native tables do — the type annotation
 * `float[N]` lives in the DDL string, not in the column metadata.
 */
function readExistingVecDim(db: Database.Database): number | undefined {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='code_chunks_vec'",
    )
    .get() as { sql?: string } | undefined;
  if (!row || !row.sql) return undefined;
  // DDL looks like: CREATE VIRTUAL TABLE code_chunks_vec USING vec0(
  //   chunk_id TEXT PRIMARY KEY, embedding float[1536] )
  const match = row.sql.match(/float\s*\[\s*(\d+)\s*\]/i);
  if (!match) return undefined;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Open the SQLite DB at `dbPath`, run both Wave-1 migrations, and
 * reload the `sqlite-vec` extension on the connection. Returns a live
 * handle; callers are responsible for `close()` when done.
 *
 * When `expectedDim` is provided, we:
 *   - Create `code_chunks_vec` at that dim if this is a fresh DB.
 *   - Refuse to open the DB (with a "delete + reindex" error) if an
 *     existing vec table has a different dim. Mixing embedders in the
 *     same index file is not supported — the float arrays aren't
 *     compatible across dimensions and there is no online migration
 *     path in this wave.
 *
 * When `expectedDim` is omitted we default to
 * {@link DEFAULT_OPENAI_DIMENSION} (1536) for back-compat with Wave 4
 * callers that haven't been taught about offline mode yet.
 */
export async function openIndexedDb(
  dbPath: string,
  expectedDim?: number,
): Promise<Database.Database> {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);

  const dim = expectedDim ?? DEFAULT_OPENAI_DIMENSION;

  // Dim-mismatch guard: if migration 002 has already run at some other
  // dim, bail before running a migration that would silently no-op on
  // the wrong-shape table. Safe to skip when the table doesn't exist
  // yet — the migration will create it at the requested dim.
  const existingDim = readExistingVecDim(db);
  if (existingDim !== undefined && existingDim !== dim) {
    db.close();
    throw new Error(
      `embed dimension mismatch (got ${existingDim}, want ${dim}). ` +
        `Delete the index file at ${dbPath} and run 'coderover reindex'.`,
    );
  }

  await migrate(db, [
    migration001Initial,
    makeSqliteVecMigration(dim),
    migration003CallEdges,
  ]);
  // The migration runs loadSqliteVec once, but better-sqlite3 requires
  // re-loading per connection. Our migrate + openDb use the same
  // connection so this is technically a no-op — keep it explicit for
  // the reuse case where a caller opens the DB without migrating.
  loadSqliteVec(db);
  return db;
}
