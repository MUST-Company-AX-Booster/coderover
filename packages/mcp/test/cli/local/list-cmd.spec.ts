import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import {
  runListCmd,
  collectIndices,
  humanSize,
  humanAge,
} from '../../../src/cli/local/list-cmd';
import { touchMeta } from '../../../src/cli/local/meta';

/** Make a fake $HOME with a populated ~/.coderover/. */
async function mkHomeWithIndices(
  entries: Array<{
    sha: string;
    sizeBytes: number;
    meta?: { projectRoot: string; indexedMs: number };
  }>,
): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'coderover-list-'));
  const dir = path.join(home, '.coderover');
  await fs.mkdir(dir, { recursive: true });
  for (const e of entries) {
    const dbPath = path.join(dir, `${e.sha}.db`);
    await fs.writeFile(dbPath, Buffer.alloc(e.sizeBytes));
    if (e.meta) {
      touchMeta(dbPath, e.meta.projectRoot, 'spec', e.meta.indexedMs);
    }
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

describe('humanSize / humanAge', () => {
  it('humanSize scales cleanly across ranges', () => {
    expect(humanSize(512)).toBe('512 B');
    expect(humanSize(2048)).toBe('2.0 KB');
    expect(humanSize(1024 * 1024 * 3.5)).toBe('3.5 MB');
    expect(humanSize(1024 * 1024 * 1024 * 2)).toBe('2.00 GB');
  });

  it('humanAge bins from just-now through years', () => {
    expect(humanAge(5_000)).toBe('just now');
    expect(humanAge(90 * 1000)).toBe('1m ago');
    expect(humanAge(2 * 3600 * 1000)).toBe('2h ago');
    expect(humanAge(2 * 24 * 3600 * 1000)).toBe('2d ago');
    expect(humanAge(45 * 24 * 3600 * 1000)).toBe('1mo ago');
    expect(humanAge(400 * 24 * 3600 * 1000)).toBe('1y ago');
  });
});

describe('collectIndices', () => {
  it('returns [] when ~/.coderover does not exist', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'coderover-nohome-'));
    expect(collectIndices(tmp)).toEqual([]);
  });

  it('discovers .db files and folds in sidecar metadata', async () => {
    const home = await mkHomeWithIndices([
      {
        sha: 'aaa',
        sizeBytes: 1024,
        meta: { projectRoot: '/real', indexedMs: 100 },
      },
      { sha: 'bbb', sizeBytes: 2048 }, // no sidecar
    ]);
    // /real must exist or it reads as orphan — create it.
    const realRoot = path.join(home, 'real-proj');
    await fs.mkdir(realRoot);
    const homeWithReal = await mkHomeWithIndices([
      {
        sha: 'aaa',
        sizeBytes: 1024,
        meta: { projectRoot: realRoot, indexedMs: 100 },
      },
    ]);
    const rows = collectIndices(homeWithReal);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sizeBytes: 1024,
      projectRoot: realRoot,
      lastIndexedAt: 100,
      orphan: false,
    });

    // Missing-sidecar case from the first home.
    const rowsNoMeta = collectIndices(home);
    const bbb = rowsNoMeta.find((r) => r.dbPath.endsWith('bbb.db'));
    expect(bbb).toBeDefined();
    expect(bbb!.projectRoot).toBeNull();
    expect(bbb!.orphan).toBe(false); // no sidecar = can't prove orphan
  });

  it('flags orphans when projectRoot does not exist', async () => {
    const home = await mkHomeWithIndices([
      {
        sha: 'ccc',
        sizeBytes: 512,
        meta: { projectRoot: '/definitely/not/there', indexedMs: 1 },
      },
    ]);
    const rows = collectIndices(home);
    expect(rows[0].orphan).toBe(true);
  });
});

describe('runListCmd', () => {
  it('prints "no indices" when the dir is empty', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'coderover-empty-'));
    const s = captureStreams();
    const code = runListCmd([], { homeDir: home, stdout: s.out, stderr: s.err });
    expect(code).toBe(0);
    expect(s.outText()).toMatch(/No local indices/);
  });

  it('prints a table with project roots', async () => {
    const home = await mkHomeWithIndices([
      {
        sha: 'xxx',
        sizeBytes: 4096,
        meta: { projectRoot: '/tmp/proj-a', indexedMs: Date.now() - 5_000 },
      },
    ]);
    const s = captureStreams();
    const code = runListCmd([], { homeDir: home, stdout: s.out, stderr: s.err });
    expect(code).toBe(0);
    expect(s.outText()).toMatch(/PROJECT/);
    expect(s.outText()).toMatch(/\/tmp\/proj-a/);
    expect(s.outText()).toMatch(/xxx\.db/);
  });

  it('emits JSON when --json is passed', async () => {
    const home = await mkHomeWithIndices([
      {
        sha: 'json1',
        sizeBytes: 128,
        meta: { projectRoot: '/p', indexedMs: 42 },
      },
    ]);
    const s = captureStreams();
    const code = runListCmd(['--json'], {
      homeDir: home,
      stdout: s.out,
      stderr: s.err,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.outText());
    expect(parsed).toHaveLength(1);
    expect(parsed[0].projectRoot).toBe('/p');
  });

  it('rejects unknown flags', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'coderover-emptyX-'));
    const s = captureStreams();
    const code = runListCmd(['--bogus'], {
      homeDir: home,
      stdout: s.out,
      stderr: s.err,
    });
    expect(code).toBe(2);
    expect(s.errText()).toMatch(/unknown flag/);
  });
});
