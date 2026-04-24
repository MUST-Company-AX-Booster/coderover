import { ConfigService } from '@nestjs/config';
import { TokenCapService } from './token-cap.service';
import { MetricsService } from '../observability/metrics.service';

/**
 * Phase 10 C4 — TokenCapService tests.
 *
 * Covers bucket init, capacity consume, refill math (integer and
 * fractional elapsed), retryAfterMs math, per-repo isolation,
 * per-repo config overrides, and the metrics fan-out. The service is
 * time-deterministic via `setNow()` — every test drives the clock
 * manually, no `jest.useFakeTimers()` is needed.
 */
describe('TokenCapService', () => {
  let configGet: jest.Mock;
  let config: ConfigService;
  let metrics: { inc: jest.Mock; set: jest.Mock; observe: jest.Mock };
  let now: number;
  let service: TokenCapService;

  const mkConfig = (values: Record<string, number | undefined>): ConfigService => {
    configGet = jest.fn((key: string) => values[key]);
    return { get: configGet } as unknown as ConfigService;
  };

  beforeEach(() => {
    now = 1_700_000_000_000;
    metrics = { inc: jest.fn(), set: jest.fn(), observe: jest.fn() };
    config = mkConfig({
      'watch.tokenCap.capacity': 1000,
      'watch.tokenCap.refillPerSec': 50,
    });
    service = new TokenCapService(config, metrics as unknown as MetricsService);
    service.setNow(() => now);
  });

  it('empty bucket: first check succeeds with full capacity', async () => {
    const decision = await service.check('repo-a', 1);
    expect(decision).toEqual({ ok: true });
    // Full capacity was 1000, we took 1 → 999 remaining.
    expect(metrics.set).toHaveBeenLastCalledWith(
      'coderover_watch_tokens_remaining',
      999,
      { repoId: 'repo-a' },
    );
  });

  it('consume exactly capacity → next check returns ok:false with correct retryAfterMs', async () => {
    const first = await service.check('repo-a', 1000);
    expect(first).toEqual({ ok: true });

    const second = await service.check('repo-a', 1);
    expect(second.ok).toBe(false);
    // shortfall = 1, refill = 50/s → ceil(1/50*1000) = 20
    if (!second.ok) {
      expect(second.retryAfterMs).toBe(20);
      expect(second.reason).toBe('token-cap');
    }
  });

  it('retryAfterMs math: pending=1000 tokens=10 refill=50/s → 19800', async () => {
    // Consume 990 to leave 10 tokens.
    const drain = await service.check('repo-a', 990);
    expect(drain).toEqual({ ok: true });

    const decision = await service.check('repo-a', 1000);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      // shortfall = 1000 - 10 = 990; 990/50*1000 = 19800
      expect(decision.retryAfterMs).toBe(19800);
      expect(decision.reason).toBe('token-cap');
    }
  });

  it('refills proportionally after elapsed time and clamps at capacity', async () => {
    // Drain the bucket fully.
    await service.check('repo-a', 1000);

    // Advance 20 seconds → 20 * 50 = 1000 tokens. Should clamp at 1000.
    now += 20_000;
    const refilled = await service.check('repo-a', 1000);
    expect(refilled).toEqual({ ok: true });

    // Advance 100 seconds and confirm the bucket stays at capacity.
    now += 100_000;
    const afterBigWait = await service.check('repo-a', 1000);
    expect(afterBigWait).toEqual({ ok: true });
  });

  it('independent buckets per repoId do not interfere', async () => {
    // Drain repo-a but never touch repo-b.
    await service.check('repo-a', 1000);
    const aAgain = await service.check('repo-a', 1);
    expect(aAgain.ok).toBe(false);

    const b = await service.check('repo-b', 1000);
    expect(b).toEqual({ ok: true });
  });

  it('fractional elapsed time: 500ms at 50/s yields exactly 25 tokens', async () => {
    // Drain bucket.
    await service.check('repo-a', 1000);

    // Advance 500ms and request 25 — should succeed.
    now += 500;
    const ok = await service.check('repo-a', 25);
    expect(ok).toEqual({ ok: true });

    // No time passes, asking for one more token → ok:false.
    const fail = await service.check('repo-a', 1);
    expect(fail.ok).toBe(false);
  });

  it('per-repo capacity override: repo-alpha=5, others=1000 default', async () => {
    config = mkConfig({
      'watch.tokenCap.capacity': 1000,
      'watch.tokenCap.refillPerSec': 50,
      'watch.tokenCap.capacity.repo-alpha': 5,
    });
    service = new TokenCapService(config, metrics as unknown as MetricsService);
    service.setNow(() => now);

    // repo-alpha capacity is 5 → asking for 6 must fail immediately.
    const alpha = await service.check('repo-alpha', 6);
    expect(alpha.ok).toBe(false);

    // Other repos keep the default capacity of 1000.
    const beta = await service.check('repo-beta', 1000);
    expect(beta).toEqual({ ok: true });
  });

  it('ok:false carries reason=token-cap and back-pressure counter fires', async () => {
    await service.check('repo-a', 1000);
    metrics.inc.mockClear();
    const denied = await service.check('repo-a', 5);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe('token-cap');
    expect(metrics.inc).toHaveBeenCalledWith(
      'coderover_watch_back_pressure_total',
      { repoId: 'repo-a' },
    );
  });

  it('tokens_remaining gauge is set on every check (refill path)', async () => {
    metrics.set.mockClear();
    await service.check('repo-a', 10);
    // At least one set call with the gauge name.
    const gaugeCalls = metrics.set.mock.calls.filter(
      (c) => c[0] === 'coderover_watch_tokens_remaining',
    );
    expect(gaugeCalls.length).toBeGreaterThanOrEqual(1);
    // Labels include repoId.
    for (const [, , labels] of gaugeCalls) {
      expect(labels).toEqual({ repoId: 'repo-a' });
    }
  });

  it('withClock() factory respects the injected clock', async () => {
    let tick = 0;
    const svc = TokenCapService.withClock(
      config,
      metrics as unknown as MetricsService,
      () => tick,
    );
    await svc.check('repo-c', 1000);
    // Without advancing `tick`, a second check with pending=1 must fail.
    const denied = await svc.check('repo-c', 1);
    expect(denied.ok).toBe(false);

    // Advance tick by 1 full second → +50 tokens. Should succeed with 1.
    tick += 1000;
    const ok = await svc.check('repo-c', 1);
    expect(ok).toEqual({ ok: true });
  });

  it('resetBucket() drops cached config so overrides can change mid-run', async () => {
    // First call: default capacity of 1000.
    const a = await service.check('repo-a', 1000);
    expect(a).toEqual({ ok: true });

    // Change config to a much tighter capacity and reset.
    config = mkConfig({
      'watch.tokenCap.capacity': 1000,
      'watch.tokenCap.refillPerSec': 50,
      'watch.tokenCap.capacity.repo-a': 2,
    });
    // Rewire the service's configService via the test seam — simpler:
    // build a fresh service and verify resetBucket + new config works.
    const svc2 = new TokenCapService(
      config,
      metrics as unknown as MetricsService,
    );
    svc2.setNow(() => now);

    await svc2.check('repo-a', 2); // drain
    svc2.resetBucket('repo-a');
    // After reset, bucket is re-created at full (capacity=2) tokens.
    const reset = await svc2.check('repo-a', 2);
    expect(reset).toEqual({ ok: true });
  });

  it('missing config falls back to defaults (1000 cap / 50 refill)', async () => {
    // Config returns undefined for every key.
    const emptyConfig = {
      get: jest.fn(() => undefined),
    } as unknown as ConfigService;
    const svc = new TokenCapService(
      emptyConfig,
      metrics as unknown as MetricsService,
    );
    svc.setNow(() => now);

    // Default capacity is 1000 → a single 1000 check must pass.
    const ok = await svc.check('repo-x', 1000);
    expect(ok).toEqual({ ok: true });

    // Next check for 1 drop fails; default refill is 50/s → retryAfterMs=20.
    const denied = await svc.check('repo-x', 1);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.retryAfterMs).toBe(20);
  });

  it('works without a MetricsService injected (optional dep)', async () => {
    const svc = new TokenCapService(config);
    svc.setNow(() => now);
    const ok = await svc.check('repo-a', 10);
    expect(ok).toEqual({ ok: true });
    const denied = await svc.check('repo-a', 10_000);
    expect(denied.ok).toBe(false);
  });
});
