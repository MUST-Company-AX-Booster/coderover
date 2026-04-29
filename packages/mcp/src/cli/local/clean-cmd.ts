/**
 * `coderover clean` — delete local-mode SQLite indices that are no
 * longer useful. Safe by default:
 *
 *   - No flags → error; we refuse to delete anything without a filter.
 *   - `--orphans` → only delete indices whose sidecar `projectRoot` no
 *     longer exists on disk. DBs without sidecars are never touched
 *     (we can't prove they're orphaned).
 *   - `--unattributed` → delete indices that have NO sidecar
 *     (`projectRoot === null`). These are pre-0.2.2 indices written
 *     before the sidecar format existed; `--orphans` deliberately can't
 *     touch them because we can't prove they're orphaned. Use this
 *     flag when you've decided the unattributed entries under
 *     `~/.coderover/` are stale and want to reclaim the space.
 *   - `--older-than <N>d` → delete indices whose last-indexed (or
 *     mtime, if no sidecar) age exceeds N days.
 *   - `--all` → every index, sidecar and all. Destructive; requires
 *     `--yes`.
 *   - `--dry-run` (default when `--yes` is absent) → print the plan,
 *     change nothing.
 *   - `--yes` → actually delete.
 *
 * Filters compose with OR semantics: `--orphans --unattributed` selects
 * any DB matching either condition.
 *
 * Every delete removes the DB plus its `-wal`, `-shm`, and `.meta.json`
 * sidecars. Idempotent: a missing sidecar is never an error.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { collectIndices, humanSize, type ListRow } from './list-cmd';
import { removeMeta } from './meta';

export interface CleanCmdDeps {
  homeDir?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  now?: () => number;
  /** Test seam — mocked in specs so we can assert the delete plan. */
  removeDb?: (dbPath: string) => void;
}

export interface CleanCmdArgs {
  orphans: boolean;
  unattributed: boolean;
  all: boolean;
  olderThanDays?: number;
  dryRun: boolean;
  yes: boolean;
  help?: boolean;
  unknown?: string;
}

export function parseCleanArgs(argv: string[]): CleanCmdArgs {
  const out: CleanCmdArgs = {
    orphans: false,
    unattributed: false,
    all: false,
    dryRun: false,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '-h' || tok === '--help') {
      out.help = true;
      continue;
    }
    if (tok === '--orphans') {
      out.orphans = true;
      continue;
    }
    if (tok === '--unattributed') {
      out.unattributed = true;
      continue;
    }
    if (tok === '--all') {
      out.all = true;
      continue;
    }
    if (tok === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (tok === '--yes' || tok === '-y') {
      out.yes = true;
      continue;
    }
    if (tok === '--older-than') {
      const raw = argv[i + 1];
      const days = parseDaySpec(raw);
      if (days === null) {
        out.unknown = `--older-than requires a value like "30d" or "14", got ${raw ?? '<none>'}`;
        return out;
      }
      out.olderThanDays = days;
      i++;
      continue;
    }
    if (tok.startsWith('--older-than=')) {
      const raw = tok.slice('--older-than='.length);
      const days = parseDaySpec(raw);
      if (days === null) {
        out.unknown = `--older-than requires a value like "30d" or "14", got ${raw}`;
        return out;
      }
      out.olderThanDays = days;
      continue;
    }
    if (tok.startsWith('-')) {
      out.unknown = `unknown flag: ${tok}`;
      return out;
    }
    out.unknown = `unexpected positional: ${tok}`;
    return out;
  }
  return out;
}

function parseDaySpec(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.match(/^(\d+)\s*d?$/i);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Decide whether a row matches the caller's selection flags. */
export function selectRows(
  rows: ListRow[],
  args: CleanCmdArgs,
  now: number,
): ListRow[] {
  if (args.all) return rows;
  const dayMs = 24 * 60 * 60 * 1000;
  return rows.filter((r) => {
    if (args.orphans && r.orphan) return true;
    // `--unattributed` targets rows that have no sidecar at all
    // (`projectRoot === null`). These were written before 0.2.2 and are
    // deliberately invisible to `--orphans` (we can't prove they're
    // orphaned without a sidecar). Disjoint from `orphan: true` by
    // construction — see `collectIndices` in list-cmd.ts.
    if (args.unattributed && r.projectRoot === null) return true;
    if (args.olderThanDays !== undefined) {
      const age = now - (r.lastIndexedAt ?? r.mtimeMs);
      if (age >= args.olderThanDays * dayMs) return true;
    }
    return false;
  });
}

export function runCleanCmd(argv: string[], deps: CleanCmdDeps = {}): number {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const homeDir = deps.homeDir ?? os.homedir();
  const now = (deps.now ?? Date.now)();
  const removeDb = deps.removeDb ?? defaultRemoveDb;

  const args = parseCleanArgs(argv);
  if (args.help) {
    stdout.write(helpText());
    return 0;
  }
  if (args.unknown) {
    stderr.write(`[coderover clean] ${args.unknown}\n`);
    return 2;
  }
  if (
    !args.orphans &&
    !args.unattributed &&
    !args.all &&
    args.olderThanDays === undefined
  ) {
    stderr.write(
      '[coderover clean] refusing to run without a filter.\n' +
        '  Pass --orphans, --unattributed, --older-than <Nd>, or --all.\n',
    );
    return 2;
  }
  if (args.all && !args.yes) {
    stderr.write(
      '[coderover clean] --all requires --yes (no dry-run fallback for destructive wipes).\n',
    );
    return 2;
  }

  const rows = collectIndices(homeDir);
  const selected = selectRows(rows, args, now);

  if (selected.length === 0) {
    stdout.write('Nothing to clean.\n');
    return 0;
  }

  const willDelete = args.yes && !args.dryRun;
  const verb = willDelete ? 'Deleting' : 'Would delete';
  stdout.write(`${verb} ${selected.length} index${selected.length === 1 ? '' : 'es'}:\n`);
  let freed = 0;
  for (const r of selected) {
    const root = r.projectRoot ?? '(unknown)';
    const tag = r.orphan ? ' [orphan]' : '';
    stdout.write(
      `  - ${path.basename(r.dbPath)}  ${humanSize(r.sizeBytes)}  ${root}${tag}\n`,
    );
    freed += r.sizeBytes;
    if (willDelete) {
      try {
        removeDb(r.dbPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stderr.write(`    failed: ${msg}\n`);
      }
    }
  }
  stdout.write(`${willDelete ? 'Freed' : 'Would free'} ${humanSize(freed)}.\n`);
  if (!willDelete) {
    stdout.write('Re-run with --yes to actually delete.\n');
  }
  return 0;
}

function defaultRemoveDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
  removeMeta(dbPath);
}

function helpText(): string {
  return [
    'coderover clean [flags]',
    '',
    'Delete local-mode SQLite indices that are no longer useful. Safe by',
    'default — refuses to run without a filter, and without --yes only',
    'prints the plan.',
    '',
    'FILTERS (at least one required unless --help)',
    '  --orphans            Delete indices whose project root no longer',
    '                       exists on disk.',
    '  --unattributed       Delete indices that have no sidecar (pre-0.2.2',
    '                       indices, listed as "(unknown — pre-0.2.2',
    '                       index)"). Disjoint from --orphans.',
    '  --older-than <Nd>    Delete indices last indexed > N days ago.',
    '  --all                Delete every index (requires --yes).',
    '',
    'FLAGS',
    '  --dry-run            Print the plan, change nothing (the default',
    '                       when --yes is absent).',
    '  -y, --yes            Actually delete. Without this flag, clean only',
    '                       previews.',
    '  -h, --help           Show this message.',
    '',
  ].join('\n');
}
