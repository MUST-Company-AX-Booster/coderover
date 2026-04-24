/**
 * chunk-id determinism + shape contract.
 *
 * `computeChunkId` is the per-chunk primary key. If its output is ever
 * non-deterministic or has the wrong shape, `code_chunks` upserts will
 * churn and the vector index will invalidate on every ingest.
 */

import { computeChunkId, CHUNK_ID_HEX_LENGTH } from '../../../src/local/ingest/chunk-id';

describe('computeChunkId', () => {
  it('is deterministic across 100 repeat calls for the same input', () => {
    const expected = computeChunkId('src/foo.ts', 10, 20);
    for (let i = 0; i < 100; i++) {
      expect(computeChunkId('src/foo.ts', 10, 20)).toBe(expected);
    }
  });

  it('produces different IDs for different filePaths with the same range', () => {
    const a = computeChunkId('src/foo.ts', 10, 20);
    const b = computeChunkId('src/bar.ts', 10, 20);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces different IDs for different ranges with the same filePath', () => {
    const a = computeChunkId('src/foo.ts', 10, 20);
    const b = computeChunkId('src/foo.ts', 10, 21);
    const c = computeChunkId('src/foo.ts', 11, 20);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it('output is exactly 16 lowercase hex chars across a variety of inputs', () => {
    const inputs: Array<[string, number, number]> = [
      ['a', 0, 0],
      ['src/日本語.ts', 1, 1],
      ['a/b/c/d.js', 1, 100000],
      ['with space.ts', 5, 7],
      ['emoji🚀.ts', 12, 34],
      ['x'.repeat(500), 1, 2],
    ];
    for (const [filePath, start, end] of inputs) {
      const id = computeChunkId(filePath, start, end);
      expect(id).toMatch(/^[0-9a-f]{16}$/);
      expect(id.length).toBe(CHUNK_ID_HEX_LENGTH);
    }
  });

  it('CHUNK_ID_HEX_LENGTH is 16', () => {
    expect(CHUNK_ID_HEX_LENGTH).toBe(16);
  });
});
