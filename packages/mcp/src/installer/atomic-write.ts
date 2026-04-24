/**
 * Atomic file write.
 *
 * Strategy: write content to a sibling `.tmp-{pid}-{ts}-{rand}` file, fsync-ish
 * (we rely on fs.writeFile's flush), then `rename` on top of the destination.
 * Rename is atomic within a single filesystem on POSIX + Windows (same
 * directory is important — this is why we stage in the SAME directory as the
 * target, not $TMPDIR).
 *
 * If the process dies mid-write, the orphan `.tmp-*` is harmless — `install`
 * sweeps orphans on the next run via `sweepOrphans()`. Nothing else reads
 * these files, so leaving them briefly is safe.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

/** Prefix used for all staging files. Must be unique enough to avoid colliding
 * with agent-owned files. */
export const TMP_PREFIX = '.tmp-coderover-';

/** How old an orphan `.tmp-coderover-*` must be before we sweep it (ms). */
export const ORPHAN_AGE_MS = 60_000;

/**
 * Write `content` to `destPath` atomically.
 *
 * Creates parent directories if they don't exist (with `recursive: true`).
 * Preserves no permissions on the destination — adapters that care (none do
 * today) should chmod after write.
 */
export async function atomicWrite(
  destPath: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(destPath);
  await fs.mkdir(dir, { recursive: true });

  const base = path.basename(destPath);
  const tmpName = `${TMP_PREFIX}${process.pid}-${Date.now()}-${randomSuffix()}-${base}`;
  const tmpPath = path.join(dir, tmpName);

  try {
    await fs.writeFile(tmpPath, content, 'utf8');
    await fs.rename(tmpPath, destPath);
  } catch (err) {
    // Best-effort cleanup; ignore cleanup errors.
    try {
      await fs.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Remove orphan `.tmp-coderover-*` staging files in `dir` older than
 * `ORPHAN_AGE_MS`. Called opportunistically before an install pass. Never
 * throws — sweep failures are logged by the caller but don't block install.
 */
export async function sweepOrphans(dir: string): Promise<string[]> {
  const swept: string[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return swept;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const full = path.join(dir, name);
    try {
      const stat = await fs.stat(full);
      if (now - stat.mtimeMs > ORPHAN_AGE_MS) {
        await fs.unlink(full);
        swept.push(full);
      }
    } catch {
      /* ignore */
    }
  }
  return swept;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
