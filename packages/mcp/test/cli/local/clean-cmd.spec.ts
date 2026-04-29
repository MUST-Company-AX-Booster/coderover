import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import {
  runCleanCmd,
  parseCleanArgs,
  selectRows,
} from '../../../src/cli/local/clean-cmd';
import { touchMeta } from '../../../src/cli/local/meta';
import type { ListRow } from '../../../src/cli/local/list-cmd';

async function mkHomeWith(
  entries: Array<{
    sha: string;
    sizeBytes: number;
    meta?: { projectRoot: string; indexedMs: number };
  }>,
): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'coderover-clean-'));
  const dir = path.join(home, '.coderover');
  await fs.mkdir(dir, { recursive: true });
  for (const e of entries) {
    const dbPath = path.join(dir, `${e.sha}.db`);
    await fs.writeFile(dbPath, Buffer.alloc(e.sizeBytes));
    if (e.meta) touchMeta(dbPath, e.meta.projectRoot, 'spec', e.meta.indexedMs);
  }
  return home;
}

function captureStreams() {
  const out = new PassThrough();
  const err = new PassThrough();
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  out.on('data', (c) => outChunks.push(c.toString()));
  err.on('data', (c) => errChunks.push(c.toString()));
  return {
    out,
    err,
    outText: () => outChunks.join(''),
    errText: () => errChunks.join(''),
  };
}

describe('parseCleanArgs', () => {
  it('parses --older-than with a trailing d', () => {
    const a = parseCleanArgs(['--older-than', '30d']);
    expect(a.olderThanDays).toBe(30);
    expect(a.unknown).toBeUndefined();
  });

  it('parses --older-than without a trailing d', () => {
    const a = parseCleanArgs(['--older-than', '7']);
    expect(a.olderThanDays).toBe(7);
  });

  it('parses --older-than=N form', () => {
    const a = parseCleanArgs(['--older-than=14d']);
    expect(a.olderThanDays).toBe(14);
  });

  it('rejects malformed --older-than', () => {
    const a = parseCleanArgs(['--older-than', 'pancakes']);
    expect(a.unknown).toMatch(/--older-than/);
  });

  it('flags unknown flags', () => {
    const a = parseCleanArgs(['--whomst']);
    expect(a.unknown).toMatch(/unknown flag/);
  });

  it('parses --unattributed (0.5.0)', () => {
    const a = parseCleanArgs(['--unattributed']);
    expect(a.unattributed).toBe(true);
    expect(a.unknown).toBeUndefined();
  });

  it('--unattributed combines with --orphans', () => {
    const a = parseCleanArgs(['--orphans', '--unattributed']);
    expect(a.orphans).toBe(true);
    expect(a.unattributed).toBe(true);
  });
});

describe('selectRows', () => {
  const now = 10_000_000;
  const dayMs = 24 * 60 * 60 * 1000;
  const mkRow = (extra: Partial<ListRow>): ListRow => ({
    dbPath: '/tmp/x.db',
    sizeBytes: 1,
    mtimeMs: now,
    projectRoot: '/p',
    lastIndexedAt: now,
    orphan: false,
    ...extra,
  });

  it('--orphans picks only orphan rows', () => {
    const rows: ListRow[] = [
      mkRow({ dbPath: '/a', orphan: true }),
      mkRow({ dbPath: '/b', orphan: false }),
    ];
    expect(
      selectRows(
        rows,
        {
          orphans: true,
          unattributed: false,
          all: false,
          dryRun: false,
          yes: false,
        },
        now,
      ).map((r) => r.dbPath),
    ).toEqual(['/a']);
  });

  it('--older-than picks rows older than N days', () => {
    const rows: ListRow[] = [
      mkRow({ dbPath: '/new', lastIndexedAt: now - 1_000 }),
      mkRow({ dbPath: '/old', lastIndexedAt: now - 40 * dayMs }),
    ];
    expect(
      selectRows(
        rows,
        {
          orphans: false,
          unattributed: false,
          all: false,
          olderThanDays: 30,
          dryRun: false,
          yes: false,
        },
        now,
      ).map((r) => r.dbPath),
    ).toEqual(['/old']);
  });

  it('--all picks everything regardless', () => {
    const rows: ListRow[] = [
      mkRow({ dbPath: '/a' }),
      mkRow({ dbPath: '/b' }),
    ];
    expect(
      selectRows(
        rows,
        {
          orphans: false,
          unattributed: false,
          all: true,
          dryRun: false,
          yes: false,
        },
        now,
      ).map((r) => r.dbPath),
    ).toEqual(['/a', '/b']);
  });

  it('--unattributed picks only rows with no sidecar (projectRoot === null)', () => {
    const rows: ListRow[] = [
      mkRow({ dbPath: '/sidecar', projectRoot: '/p', orphan: false }),
      mkRow({ dbPath: '/orphan', projectRoot: '/dead', orphan: true }),
      mkRow({
        dbPath: '/preold',
        projectRoot: null,
        lastIndexedAt: null,
        orphan: false,
      }),
    ];
    expect(
      selectRows(
        rows,
        {
          orphans: false,
          unattributed: true,
          all: false,
          dryRun: false,
          yes: false,
        },
        now,
      ).map((r) => r.dbPath),
    ).toEqual(['/preold']);
  });

  it('--unattributed and --orphans are disjoint and OR-compose', () => {
    const rows: ListRow[] = [
      mkRow({ dbPath: '/orphan', projectRoot: '/dead', orphan: true }),
      mkRow({
        dbPath: '/preold',
        projectRoot: null,
        lastIndexedAt: null,
        orphan: false,
      }),
      mkRow({ dbPath: '/keep', projectRoot: '/p', orphan: false }),
    ];
    const sel = selectRows(
      rows,
      {
        orphans: true,
        unattributed: true,
        all: false,
        dryRun: false,
        yes: false,
      },
      now,
    ).map((r) => r.dbPath);
    expect(sel.sort()).toEqual(['/orphan', '/preold']);
  });

  it('combining --orphans and --older-than is OR, not AND', () => {
    const rows: ListRow[] = [
      mkRow({ dbPath: '/orphan-new', orphan: true, lastIndexedAt: now }),
      mkRow({ dbPath: '/fresh', orphan: false, lastIndexedAt: now }),
      mkRow({
        dbPath: '/stale',
        orphan: false,
        lastIndexedAt: now - 40 * dayMs,
      }),
    ];
    const sel = selectRows(
      rows,
      {
        orphans: true,
        unattributed: false,
        all: false,
        olderThanDays: 30,
        dryRun: false,
        yes: false,
      },
      now,
    ).map((r) => r.dbPath);
    expect(sel.sort()).toEqual(['/orphan-new', '/stale']);
  });
});

describe('runCleanCmd', () => {
  it('refuses to run without a filter', async () => {
    const home = await mkHomeWith([]);
    const s = captureStreams();
    const code = runCleanCmd([], {
      homeDir: home,
      stdout: s.out,
      stderr: s.err,
    });
    expect(code).toBe(2);
    expect(s.errText()).toMatch(/refusing to run without a filter/);
  });

  it('--all without --yes is rejected', async () => {
    const home = await mkHomeWith([]);
    const s = captureStreams();
    const code = runCleanCmd(['--all'], {
      homeDir: home,
      stdout: s.out,
      stderr: s.err,
    });
    expect(code).toBe(2);
    expect(s.errText()).toMatch(/--all requires --yes/);
  });

  it('dry-run by default — lists candidates without deleting', async () => {
    const home = await mkHomeWith([
      {
        sha: 'orph',
        sizeBytes: 100,
        meta: { projectRoot: '/missing/path', indexedMs: Date.now() },
      },
    ]);
    const s = captureStreams();
    const removed: string[] = [];
    const code = runCleanCmd(['--orphans'], {
      homeDir: home,
      stdout: s.out,
      stderr: s.err,
      removeDb: (p) => removed.push(p),
    });
    expect(code).toBe(0);
    expect(s.outText()).toMatch(/Would delete 1 index/);
    expect(s.outText()).toMatch(/Re-run with --yes/);
    expect(removed).toEqual([]);
  });

  it('--yes actually invokes removeDb for each match', async () => {
    const home = await mkHomeWith([]);
    // Seed after so we can reference `home` as a non-orphan projectRoot.
    await fs.writeFile(path.join(home, '.coderover', 'o1.db'), Buffer.alloc(1));
    touchMeta(
      path.join(home, '.coderover', 'o1.db'),
      '/nope1',
      'spec',
      Date.now(),
    );
    await fs.writeFile(path.join(home, '.coderover', 'o2.db'), Buffer.alloc(2));
    touchMeta(
      path.join(home, '.coderover', 'o2.db'),
      '/nope2',
      'spec',
      Date.now(),
    );
    await fs.writeFile(
      path.join(home, '.coderover', 'keep.db'),
      Buffer.alloc(3),
    );
    touchMeta(
      path.join(home, '.coderover', 'keep.db'),
      home,
      'spec',
      Date.now(),
    );
    const s = captureStreams();
    const removed: string[] = [];
    const code = runCleanCmd(['--orphans', '--yes'], {
      homeDir: home,
      stdout: s.out,
      stderr: s.err,
      removeDb: (p) => removed.push(p),
    });
    expect(code).toBe(0);
    expect(removed.map((p) => path.basename(p)).sort()).toEqual([
      'o1.db',
      'o2.db',
    ]);
    expect(s.outText()).toMatch(/Deleting 2 indexes/);
  });

  it('--unattributed targets pre-0.2.2 indices (no sidecar) and skips attributed ones (0.5.0)', async () => {
    // Three DBs: one with no sidecar (the pre-0.2.2 entry we want to
    // clean), one with a sidecar pointing at an existing dir (keep),
    // and one with a sidecar pointing at a missing dir (orphan, NOT
    // selected by --unattributed).
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'coderover-clean-unattr-'));
    await fs.mkdir(path.join(home, '.coderover'), { recursive: true });
    // Pre-0.2.2 — bare DB, no .meta.json sidecar.
    await fs.writeFile(
      path.join(home, '.coderover', 'preold.db'),
      Buffer.alloc(10),
    );
    // Attributed, healthy.
    await fs.writeFile(
      path.join(home, '.coderover', 'keep.db'),
      Buffer.alloc(10),
    );
    touchMeta(path.join(home, '.coderover', 'keep.db'), home, 'spec', Date.now());
    // Attributed, but root missing → --orphans territory, not --unattributed.
    await fs.writeFile(
      path.join(home, '.coderover', 'orph.db'),
      Buffer.alloc(10),
    );
    touchMeta(
      path.join(home, '.coderover', 'orph.db'),
      '/missing/dir',
      'spec',
      Date.now(),
    );

    const s = captureStreams();
    const removed: string[] = [];
    const code = runCleanCmd(['--unattributed', '--yes'], {
      homeDir: home,
      stdout: s.out,
      stderr: s.err,
      removeDb: (p) => removed.push(p),
    });
    expect(code).toBe(0);
    expect(removed.map((p) => path.basename(p))).toEqual(['preold.db']);
    expect(s.outText()).toMatch(/Deleting 1 index/);
  });

  it('refuses to run with no filter and now mentions --unattributed in the hint (0.5.0)', async () => {
    const home = await mkHomeWith([]);
    const s = captureStreams();
    const code = runCleanCmd([], {
      homeDir: home,
      stdout: s.out,
      stderr: s.err,
    });
    expect(code).toBe(2);
    expect(s.errText()).toMatch(/--unattributed/);
  });

  it('prints "Nothing to clean" when no row matches', async () => {
    const home = await mkHomeWith([]);
    await fs.writeFile(
      path.join(home, '.coderover', 'fresh.db'),
      Buffer.alloc(1),
    );
    touchMeta(
      path.join(home, '.coderover', 'fresh.db'),
      home,
      'spec',
      Date.now(),
    );
    const s = captureStreams();
    const code = runCleanCmd(['--orphans'], {
      homeDir: home,
      stdout: s.out,
      stderr: s.err,
    });
    expect(code).toBe(0);
    expect(s.outText()).toMatch(/Nothing to clean/);
  });
});
