/**
 * `coderover list` — enumerate every local-mode SQLite index under
 * `~/.coderover/` along with the project root it was built from (from
 * the sidecar written by {@link ./meta.touchMeta}), its size on disk,
 * and its last-indexed timestamp.
 *
 * Pure reader — never writes. Safe to run on any machine with a broken
 * native better-sqlite3 build because we never open the DBs.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readMeta } from './meta';

export interface ListCmdDeps {
  homeDir?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  now?: () => number;
}

export interface ListRow {
  dbPath: string;
  sizeBytes: number;
  mtimeMs: number;
  projectRoot: string | null;
  lastIndexedAt: number | null;
  /** `true` when the sidecar points at a path that no longer exists. */
  orphan: boolean;
}

/** Enumerate indices. Exported for `clean`'s reuse. */
export function collectIndices(homeDir: string): ListRow[] {
  const dir = path.join(homeDir, '.coderover');
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const rows: ListRow[] = [];
  for (const name of entries) {
    if (!name.endsWith('.db')) continue;
    const dbPath = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dbPath);
    } catch {
      continue;
    }
    const meta = readMeta(dbPath);
    const orphan =
      meta !== null && !pathExists(meta.projectRoot);
    rows.push({
      dbPath,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      projectRoot: meta?.projectRoot ?? null,
      lastIndexedAt: meta?.lastIndexedAt ?? null,
      orphan,
    });
  }
  // Newest first — matches the user's mental model ("my last repo").
  rows.sort((a, b) => (b.lastIndexedAt ?? b.mtimeMs) - (a.lastIndexedAt ?? a.mtimeMs));
  return rows;
}

export function runListCmd(argv: string[], deps: ListCmdDeps = {}): number {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const homeDir = deps.homeDir ?? os.homedir();
  const now = (deps.now ?? Date.now)();

  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(helpText());
    return 0;
  }
  const json = argv.includes('--json');
  const unknown = argv.find(
    (a) => a.startsWith('-') && a !== '--json' && a !== '-h' && a !== '--help',
  );
  if (unknown) {
    stderr.write(`[coderover list] unknown flag: ${unknown}\n`);
    return 2;
  }

  const rows = collectIndices(homeDir);

  if (json) {
    stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return 0;
  }

  if (rows.length === 0) {
    stdout.write(
      `No local indices found under ${path.join(homeDir, '.coderover')}.\n` +
        'Run `coderover index <path>` to create one.\n',
    );
    return 0;
  }

  // Human-readable table. No third-party table lib — 4 columns, fixed
  // widths sized to the data.
  const header = ['PROJECT', 'LAST INDEXED', 'SIZE', 'DB'];
  const data = rows.map((r) => [
    r.projectRoot
      ? r.orphan
        ? `${r.projectRoot}  (orphan)`
        : r.projectRoot
      : '(unknown — pre-0.2.2 index)',
    r.lastIndexedAt ? humanAge(now - r.lastIndexedAt) : humanAge(now - r.mtimeMs),
    humanSize(r.sizeBytes),
    path.basename(r.dbPath),
  ]);

  const cols = header.map((_, c) =>
    Math.max(header[c].length, ...data.map((d) => d[c].length)),
  );
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(cols[i], ' ')).join('  ');

  stdout.write(line(header) + '\n');
  for (const d of data) stdout.write(line(d) + '\n');

  const orphans = rows.filter((r) => r.orphan).length;
  if (orphans > 0) {
    stdout.write(
      `\n${orphans} orphan index${orphans === 1 ? '' : 'es'} — ` +
        `run \`coderover clean --orphans\` to reclaim.\n`,
    );
  }
  return 0;
}

function helpText(): string {
  return [
    'coderover list [--json]',
    '',
    'List every local-mode SQLite index under ~/.coderover/ with its',
    'project root, size, and last-indexed time.',
    '',
    'FLAGS',
    '  --json       Emit machine-readable JSON instead of a table.',
    '  -h, --help   Show this message.',
    '',
  ].join('\n');
}

function pathExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Format a byte count as B / KB / MB / GB. */
export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Format a millisecond age as a single coarse unit ("3d", "5h", "just now"). */
export function humanAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}
