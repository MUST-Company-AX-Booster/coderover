/**
 * Phase 11 Wave 3 — benchmark harness utilities for local-mode MCP.
 *
 * Lifted (contract-identically) from `coderover-api/benchmarks/_harness.ts`
 * so our two benchmark suites report numbers the same way. Dependency-free
 * on purpose — the runner scripts and `harness.spec.ts` integrity check
 * both import from here, and we don't want jest to drag in the Nest
 * container or the mcp package's native deps.
 *
 * Tiny by design: measure one closure's wall time, compute a percentile
 * over a sample, render a markdown table, and print a ms/MB/count-aware
 * summary. Past ~200 lines, pull in a real stats library.
 */

/**
 * Run `fn` and return its wall-time in milliseconds (fractional). Uses
 * `performance.now()` for sub-ms precision. The callable may be sync or
 * async — awaiting a non-promise is cheap and we'd rather keep one code
 * path than split.
 */
export async function measure<T>(
  fn: () => Promise<T> | T,
): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  return { result, ms };
}

/**
 * Percentile of a numeric sample using the nearest-rank method
 * (NIST "Method 1"): the smallest value x in the sorted sample such
 * that at least p% of observations ≤ x.
 *
 *   - percentile([1..100], 50) === 50
 *   - percentile([1,2,3], 99)  === 3    (saturates at max)
 *   - percentile([1,2,3], 0)   === 1    (saturates at min)
 *
 * Nearest-rank over linear interpolation because it always returns an
 * actually-observed value — no imaginary ms-reading between two real
 * ones — matching how Prometheus `quantile` and most engineers
 * informally reason about percentiles.
 *
 * Non-finite values are filtered out (a NaN observation shouldn't skew
 * the stat; better to report on fewer points and flag it upstream).
 */
export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const clean = values
    .filter((v) => Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  if (!clean.length) return NaN;

  const q = Math.min(100, Math.max(0, p));
  if (q <= 0) return clean[0];
  if (q >= 100) return clean[clean.length - 1];

  // Nearest-rank: rank = ceil(q/100 * n). Array is 0-indexed so
  // subtract 1 after the ceil.
  const rank = Math.ceil((q / 100) * clean.length);
  return clean[rank - 1];
}

/**
 * Render a markdown table. Row values may be strings or numbers;
 * numbers are coerced with `String()` so the caller controls formatting
 * (e.g. `n.toFixed(2)`). Every row MUST have one cell per header — we
 * throw rather than silently pad.
 */
export function formatTable(
  headers: string[],
  rows: Array<Array<string | number>>,
): string {
  if (!headers.length) throw new Error('formatTable: headers must not be empty');
  for (const [i, row] of rows.entries()) {
    if (row.length !== headers.length) {
      throw new Error(
        `formatTable: row ${i} has ${row.length} cells, expected ${headers.length}`,
      );
    }
  }

  const body = rows.map((r) => r.map((c) => String(c)));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...body.map((r) => r[i].length)),
  );

  const fmt = (cells: string[]) =>
    `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;

  const sep = `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`;

  return [fmt(headers), sep, ...body.map(fmt)].join('\n');
}

/**
 * Convenience: compute p50/p95/p99 from a sample. Returned in the same
 * unit the samples were provided in — no unit conversion.
 */
export function summarize(samples: number[]): {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
} {
  if (!samples.length) {
    return { count: 0, p50: NaN, p95: NaN, p99: NaN, min: NaN, max: NaN, mean: NaN };
  }
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    count: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    min: Math.min(...samples),
    max: Math.max(...samples),
    mean: sum / samples.length,
  };
}

/**
 * Wrap `summarize` with a caller-chosen unit label so multiple
 * benchmarks in one run can report consistently (e.g. "ms" vs "MB" vs
 * "count") without each runner re-implementing its own printf.
 *
 * Returned shape matches `summarize` plus the `label` and `unit` keys
 * so callers that want the raw numbers (for a threshold check) don't
 * lose access to them.
 */
export function summarizeWithUnit(
  label: string,
  samples: number[],
  unitLabel: string,
): {
  label: string;
  unit: string;
  count: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
} {
  const s = summarize(samples);
  return { label, unit: unitLabel, ...s };
}
