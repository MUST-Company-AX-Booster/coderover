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
 * Resolve the project root.
 *
 * - **Explicit `inputPath`**: trust the user. Return the path itself
 *   (or its parent if it's a file). We do NOT walk up — pre-0.5.1
 *   `index ./my-repo` could silently index a parent dir if any
 *   ancestor had a `package.json`/`.git`/etc., which is a footgun
 *   especially in monorepos and quick-test directories.
 * - **No `inputPath`**: walk up from cwd looking for a project-root
 *   marker. This is the "find the project I'm in" path and is the
 *   only place ancestor walk-up makes sense.
 *
 * In both cases the input is canonicalized via `path.resolve`. Falls
 * back to the resolved input if the path doesn't exist on disk yet.
 */
export function resolveProjectRoot(inputPath: string | undefined): string {
  const start = path.resolve(inputPath ?? process.cwd());

  // If the path doesn't exist, return it as-is; the caller will surface
  // a clear error when it tries to walk the tree.
  if (!fs.existsSync(start)) return start;

  // If the input is a file, treat its parent directory as the root.
  let cur = start;
  try {
    const stat = fs.statSync(start);
    if (!stat.isDirectory()) {
      cur = path.dirname(start);
    }
  } catch {
    // ignore — we already checked existence above, but a race is possible.
  }

  // Explicit path → trust it. Do not walk up.
  if (inputPath !== undefined) return cur;

  // No-arg case: walk up from cwd looking for a manifest marker.
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
 * Canonicalize a filesystem path through `realpath` so symlinks collapse
 * onto their target. Used as the input to the DB-path SHA so that
 * `/tmp/foo` and `/private/tmp/foo` (macOS) — or container bind-mount
 * pairs on Linux — hash to the same `<sha>.db`. Falls back to
 * `path.resolve` when the path doesn't exist yet (the common case
 * during install/dry-run).
 *
 * Exported so `cli/install.ts::defaultDbPath` reuses the same helper —
 * the installer config and the index/watch runtime MUST resolve to the
 * same on-disk DB file. Pre-0.5.1 the two helpers duplicated this
 * logic; a prior drift (12 vs 16 hex chars) had already caused a real
 * bug, so consolidating eliminates that drift class entirely.
 */
export function canonicalizeForHash(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch (err) {
    // ENOENT is the only legitimate fallback case (install / dry-run on
    // a path that doesn't exist on disk yet). Other errors — EACCES on
    // a mid-tree permission flip, ELOOP on a symlink cycle, ENAMETOOLONG —
    // would silently split the user's index across two `<sha>.db` files
    // (one canonicalized, one not) if we swallowed them. Let those propagate.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT') {
      throw err;
    }
    return resolved;
  }
}

/**
 * Resolve the on-disk path for the SQLite DB corresponding to
 * `projectRoot`. Lives under `~/.coderover/` — the same directory the
 * installer places its config under.
 *
 * Hash collisions are effectively impossible at the expected scale
 * (hundreds of projects per user at most) with 16 hex chars of SHA256.
 *
 * The input is canonicalized via realpath before hashing — see
 * {@link canonicalizeForHash} — so symlinked alternative paths to the
 * same physical directory share one DB.
 */
export function resolveDbPath(projectRoot: string): string {
  const sha = crypto
    .createHash('sha256')
    .update(canonicalizeForHash(projectRoot))
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
    // Probe the companion package synchronously so reindex / index can
    // fail BEFORE touching disk if the user typoed `--embed offline`
    // without `@coderover/mcp-offline` installed. The OfflineEmbedder
    // itself only requires `@xenova/transformers` lazily on first
    // .embed() call, which is too late for the pre-flight check in
    // reindex (post-unlink).
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require.resolve('@xenova/transformers');
    } catch (err) {
      // Only convert MODULE_NOT_FOUND into the install hint. Other
      // errors (EACCES on a corrupted node_modules, malformed
      // package.json, ERR_PACKAGE_PATH_NOT_EXPORTED) get rethrown
      // verbatim so the user isn't sent down the wrong remediation.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'MODULE_NOT_FOUND') {
        throw err;
      }
      const orig = err instanceof Error ? err.message : String(err);
      throw new Error(
        'CODEROVER_EMBED_MODE=offline requires the companion package ' +
          '@coderover/mcp-offline, which bundles @xenova/transformers.\n\n' +
          '  npm install @coderover/mcp-offline\n\n' +
          'Previously this was an `optionalDependencies` of @coderover/mcp, ' +
          'but the 45 MB ONNX runtime it pulled in (plus a 5-CVE transitive ' +
          'chain via protobufjs) was unwanted weight on every install. The ' +
          'split lets remote-mode and openai-embed users skip it entirely.\n\n' +
          `Original error: ${orig}`,
      );
    }
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
