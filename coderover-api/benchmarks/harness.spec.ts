/**
 * Phase 10 C5 — integrity tests for the benchmark harness utilities.
 *
 * Scope: just the pure functions in `_harness.ts`. We do NOT exercise
 * the benchmark runners themselves — they're long-running, wall-clock
 * sensitive, and meant to be invoked manually.
 */

import { percentile, formatTable, summarize, measure } from './_harness';

describe('_harness.percentile', () => {
  it('percentile([1..100], 50) === 50 (nearest-rank contract)', () => {
    const data = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(data, 50)).toBe(50);
  });

  it('percentile([1,2,3], 99) === 3', () => {
    expect(percentile([1, 2, 3], 99)).toBe(3);
  });

  it('saturates at max for p100 / p99 on short samples', () => {
    expect(percentile([1, 2, 3], 100)).toBe(3);
  });

  it('saturates at min for p0', () => {
    expect(percentile([1, 2, 3], 0)).toBe(1);
  });

  it('returns NaN on empty input', () => {
    expect(percentile([], 50)).toBeNaN();
  });

  it('filters non-finite values before ranking', () => {
    expect(percentile([1, 2, NaN, Infinity, 3], 50)).toBe(2);
  });

  it('is stable across p-values (monotonic non-decreasing)', () => {
    const data = [4, 1, 3, 2, 5, 7, 6, 10, 8, 9];
    const p25 = percentile(data, 25);
    const p50 = percentile(data, 50);
    const p75 = percentile(data, 75);
    const p95 = percentile(data, 95);
    expect(p25).toBeLessThanOrEqual(p50);
    expect(p50).toBeLessThanOrEqual(p75);
    expect(p75).toBeLessThanOrEqual(p95);
  });
});

describe('_harness.formatTable', () => {
  it('produces a markdown table with header, separator, body', () => {
    const out = formatTable(
      ['scenario', 'p50'],
      [
        ['reingest', '0.42'],
        ['watch', '512.00'],
      ],
    );
    const lines = out.split('\n');
    expect(lines).toHaveLength(4); // header, sep, 2 body rows
    expect(lines[0]).toMatch(/^\|\s*scenario\s*\|\s*p50\s*\|$/);
    expect(lines[1]).toMatch(/^\|\s*-+\s*\|\s*-+\s*\|$/);
    expect(lines[2]).toContain('reingest');
    expect(lines[3]).toContain('watch');
  });

  it('accepts numeric cells by coercing to string', () => {
    const out = formatTable(['n'], [[42]]);
    expect(out).toContain('42');
  });

  it('pads columns so pipes line up', () => {
    const out = formatTable(['a', 'b'], [['short', 'x'], ['a-longer', 'y']]);
    const rowLines = out.split('\n').filter((l) => l.startsWith('|'));
    const widths = rowLines.map((l) => l.length);
    // Every line should be the same rendered width (that's the point
    // of padding).
    expect(new Set(widths).size).toBe(1);
  });

  it('throws when a row has the wrong cell count', () => {
    expect(() => formatTable(['a', 'b'], [['only-one']])).toThrow(
      /1 cells, expected 2/,
    );
  });

  it('throws when headers are empty', () => {
    expect(() => formatTable([], [])).toThrow(/headers must not be empty/);
  });
});

describe('_harness.summarize', () => {
  it('computes p50/p95/p99/min/max/mean', () => {
    const s = summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s.count).toBe(10);
    expect(s.min).toBe(1);
    expect(s.max).toBe(10);
    expect(s.mean).toBeCloseTo(5.5, 5);
    expect(s.p50).toBeGreaterThanOrEqual(5);
    expect(s.p50).toBeLessThanOrEqual(6);
    expect(s.p95).toBeGreaterThan(s.p50);
    expect(s.p99).toBeGreaterThanOrEqual(s.p95);
  });

  it('returns NaN fields on empty input', () => {
    const s = summarize([]);
    expect(s.count).toBe(0);
    expect(s.p50).toBeNaN();
    expect(s.mean).toBeNaN();
  });
});

describe('_harness.measure', () => {
  it('returns both result and elapsed ms', async () => {
    const { result, ms } = await measure(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 42;
    });
    expect(result).toBe(42);
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(ms)).toBe(true);
  });

  it('works with a sync function', async () => {
    const { result, ms } = await measure(() => 'ok');
    expect(result).toBe('ok');
    expect(ms).toBeGreaterThanOrEqual(0);
  });
});
