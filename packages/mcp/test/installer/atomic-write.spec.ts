/**
 * Atomic write + orphan sweep tests.
 *
 * Uses a real tmpdir (fs/promises not mocked here) so we exercise the actual
 * rename semantics we rely on. Mocking fs for this specific test would hide
 * the bug class this code exists to prevent.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWrite, sweepOrphans, TMP_PREFIX } from '../../src/installer/atomic-write';

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'coderover-atomic-'));
}

describe('atomicWrite', () => {
  it('writes new file content atomically', async () => {
    const dir = await mkTmpDir();
    const p = path.join(dir, 'config.json');
    await atomicWrite(p, '{"ok":true}\n');
    expect(await fs.readFile(p, 'utf8')).toBe('{"ok":true}\n');
  });

  it('overwrites an existing file', async () => {
    const dir = await mkTmpDir();
    const p = path.join(dir, 'config.json');
    await fs.writeFile(p, 'old');
    await atomicWrite(p, 'new');
    expect(await fs.readFile(p, 'utf8')).toBe('new');
  });

  it('creates parent dirs as needed', async () => {
    const dir = await mkTmpDir();
    const p = path.join(dir, 'nested', 'deep', 'file.txt');
    await atomicWrite(p, 'hi');
    expect(await fs.readFile(p, 'utf8')).toBe('hi');
  });

  it('leaves no .tmp-coderover-* file behind on success', async () => {
    const dir = await mkTmpDir();
    const p = path.join(dir, 'x.json');
    await atomicWrite(p, 'content');
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.startsWith(TMP_PREFIX))).toEqual([]);
  });
});

describe('sweepOrphans', () => {
  it('removes orphan .tmp-coderover-* files older than ORPHAN_AGE_MS', async () => {
    const dir = await mkTmpDir();
    const orphan = path.join(dir, `${TMP_PREFIX}999999-123-abc-config.json`);
    await fs.writeFile(orphan, 'abandoned');
    // Age it past threshold.
    const past = Date.now() / 1000 - 120;
    await fs.utimes(orphan, past, past);

    const swept = await sweepOrphans(dir);
    expect(swept).toContain(orphan);
    await expect(fs.access(orphan)).rejects.toThrow();
  });

  it('leaves recent orphans alone (race safety for in-flight writes)', async () => {
    const dir = await mkTmpDir();
    const orphan = path.join(dir, `${TMP_PREFIX}fresh-000-abc-config.json`);
    await fs.writeFile(orphan, 'in-flight');
    const swept = await sweepOrphans(dir);
    expect(swept).not.toContain(orphan);
    expect(await fs.readFile(orphan, 'utf8')).toBe('in-flight');
  });

  it('ignores non-prefixed files', async () => {
    const dir = await mkTmpDir();
    const user = path.join(dir, 'my-config.json');
    await fs.writeFile(user, 'real');
    const past = Date.now() / 1000 - 120;
    await fs.utimes(user, past, past);
    await sweepOrphans(dir);
    expect(await fs.readFile(user, 'utf8')).toBe('real');
  });

  it('tolerates missing directories without throwing', async () => {
    const missing = path.join(os.tmpdir(), 'coderover-never-exists-xyz123');
    await expect(sweepOrphans(missing)).resolves.toEqual([]);
  });
});
