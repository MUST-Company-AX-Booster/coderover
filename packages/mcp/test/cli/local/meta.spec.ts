import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  metaPathFor,
  readMeta,
  touchMeta,
  removeMeta,
} from '../../../src/cli/local/meta';

async function mkTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'coderover-meta-'));
}

describe('meta', () => {
  it('metaPathFor swaps .db → .meta.json', () => {
    expect(metaPathFor('/x/abc.db')).toBe('/x/abc.meta.json');
  });

  it('metaPathFor tolerates non-.db suffixes', () => {
    expect(metaPathFor('/x/weird')).toBe('/x/weird.meta.json');
  });

  it('readMeta returns null when sidecar is missing', async () => {
    const tmp = await mkTmp();
    expect(readMeta(path.join(tmp, 'nonexistent.db'))).toBeNull();
  });

  it('touchMeta writes a sidecar on first call', async () => {
    const tmp = await mkTmp();
    const dbPath = path.join(tmp, 'idx.db');
    touchMeta(dbPath, '/home/me/project', 'test-ver', 1_000);
    const meta = readMeta(dbPath);
    expect(meta).toEqual({
      projectRoot: '/home/me/project',
      firstIndexedAt: 1_000,
      lastIndexedAt: 1_000,
      writtenBy: 'test-ver',
    });
  });

  it('touchMeta preserves firstIndexedAt on subsequent calls', async () => {
    const tmp = await mkTmp();
    const dbPath = path.join(tmp, 'idx.db');
    touchMeta(dbPath, '/p', 'v1', 1_000);
    touchMeta(dbPath, '/p', 'v2', 2_000);
    const meta = readMeta(dbPath);
    expect(meta?.firstIndexedAt).toBe(1_000);
    expect(meta?.lastIndexedAt).toBe(2_000);
    expect(meta?.writtenBy).toBe('v2');
  });

  it('readMeta returns null for malformed json', async () => {
    const tmp = await mkTmp();
    const dbPath = path.join(tmp, 'idx.db');
    await fs.writeFile(metaPathFor(dbPath), 'not-json');
    expect(readMeta(dbPath)).toBeNull();
  });

  it('readMeta returns null when required fields missing', async () => {
    const tmp = await mkTmp();
    const dbPath = path.join(tmp, 'idx.db');
    await fs.writeFile(
      metaPathFor(dbPath),
      JSON.stringify({ projectRoot: '/x' }),
    );
    expect(readMeta(dbPath)).toBeNull();
  });

  it('removeMeta deletes the sidecar and is idempotent', async () => {
    const tmp = await mkTmp();
    const dbPath = path.join(tmp, 'idx.db');
    touchMeta(dbPath, '/p', 'v', 1);
    removeMeta(dbPath);
    expect(readMeta(dbPath)).toBeNull();
    // Second call must not throw.
    removeMeta(dbPath);
  });
});
