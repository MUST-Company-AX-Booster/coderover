/**
 * Phase 10 A5 — infra availability probe.
 *
 * A5 is intentionally designed to run without Postgres/Redis/Memgraph
 * (the test-backend mocks all three). Some scenarios, though, could
 * optionally upgrade to a real service if one is reachable — that path
 * is NOT wired yet, but this probe lands here so future work can flip
 * individual `describe.skipIf(...)` gates without rewriting the scenarios.
 *
 * Each probe returns `{ available, reason }`. On `available: false` the
 * scenario calls `skipSuite(reason)` at the top of the file (see examples
 * in `confidence.spec.ts`). The whole suite should NEVER fail because
 * infra is absent — skipping is the correctness condition.
 */

export interface ProbeResult {
  available: boolean;
  reason?: string;
}

function probeEnvVar(name: string): ProbeResult {
  if (process.env[name]) {
    return { available: true };
  }
  return { available: false, reason: `${name} env var not set` };
}

/**
 * Is a real Postgres reachable? Checked ONLY via `DATABASE_URL` / `PG_URL`.
 * We deliberately do NOT dial TCP — a cold connect would add seconds of
 * latency to the happy path (where mocks cover everything anyway).
 */
export function probePostgres(): ProbeResult {
  if (process.env.DATABASE_URL || process.env.PG_URL) {
    return { available: true };
  }
  return { available: false, reason: 'DATABASE_URL/PG_URL not set — mocks in use' };
}

/** Is a real Memgraph reachable? `MEMGRAPH_URI` signals intent. */
export function probeMemgraph(): ProbeResult {
  return probeEnvVar('MEMGRAPH_URI');
}

/** Is a real Redis reachable? `REDIS_URL` / `REDIS_HOST` signal intent. */
export function probeRedis(): ProbeResult {
  if (process.env.REDIS_URL || process.env.REDIS_HOST) {
    return { available: true };
  }
  return { available: false, reason: 'REDIS_URL/REDIS_HOST not set — mocks in use' };
}

/**
 * Emit a clear log line explaining the skip.
 *
 * Using `console.info` so it survives Jest's quiet mode; scenarios wrap
 * this in a `beforeAll` + `describe.skip` pattern rather than calling it
 * inline (see templates in the spec files).
 */
export function logSkip(scenario: string, reason: string): void {
  // eslint-disable-next-line no-console
  console.info(`[a5-integration] skipping ${scenario}: ${reason}`);
}
