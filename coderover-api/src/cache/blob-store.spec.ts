import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { LocalFsBlobStore, buildBlobPath } from './blob-store';

/**
 * Phase 10 C1 — LocalFsBlobStore tests.
 *
 * Covers the happy-path round-trip plus the missing-file edge cases
 * that higher-level services depend on.
 */
describe('LocalFsBlobStore', () => {
  let root: string;
  let store: LocalFsBlobStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'coderover-cache-'));
    store = new LocalFsBlobStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('round-trips put → get', async () => {
    const p = buildBlobPath('ast', 'abcd1234' + '0'.repeat(56));
    const data = Buffer.from('some bytes', 'utf8');
    await store.put(p, data);
    const got = await store.get(p);
    expect(got?.equals(data)).toBe(true);
  });

  it('returns null for a missing blob', async () => {
    const p = buildBlobPath('ast', 'beefcafe' + '0'.repeat(56));
    expect(await store.get(p)).toBeNull();
  });

  it('reports existence correctly', async () => {
    const p = buildBlobPath('symbols', 'deadbeef' + '0'.repeat(56));
    expect(await store.exists(p)).toBe(false);
    await store.put(p, Buffer.from('x'));
    expect(await store.exists(p)).toBe(true);
  });

  it('delete is a no-op on missing blobs', async () => {
    const p = buildBlobPath('ast', 'feedface' + '0'.repeat(56));
    await expect(store.delete(p)).resolves.toBeUndefined();
  });

  it('creates the two-level shard directories under root', async () => {
    const key = '1234567890' + '0'.repeat(54);
    const p = buildBlobPath('embeddings', key);
    await store.put(p, Buffer.from('z'));
    const expectedDir = path.join(root, 'cache', 'embeddings', '12', '34');
    const entries = await fs.readdir(expectedDir);
    expect(entries.some((n) => n.endsWith(`${key}.bin`))).toBe(true);
  });

  it('overwrites an existing blob atomically (no leftover tmp file)', async () => {
    const p = buildBlobPath('ast', 'cafebabe' + '0'.repeat(56));
    await store.put(p, Buffer.from('v1'));
    await store.put(p, Buffer.from('v2'));
    const got = await store.get(p);
    expect(got?.toString()).toBe('v2');

    const dir = path.join(root, 'cache', 'ast', 'ca', 'fe');
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.includes('.tmp-'))).toEqual([]);
  });

  it('rejects a blob path that escapes the root dir', async () => {
    const evil = '../../../../etc/passwd';
    await expect(store.get(evil)).rejects.toThrow(/escaped root/);
    await expect(store.put(evil, Buffer.from('x'))).rejects.toThrow(
      /escaped root/,
    );
  });
});

describe('buildBlobPath', () => {
  it('uses POSIX separators + two-level shards', () => {
    const key = 'abcdef' + '0'.repeat(58);
    expect(buildBlobPath('ast', key)).toBe(`cache/ast/ab/cd/${key}.bin`);
  });

  it('throws on too-short keys', () => {
    expect(() => buildBlobPath('ast', 'abc')).toThrow();
  });
});
