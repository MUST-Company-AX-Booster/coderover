import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BudgetGuard } from './watch-daemon.service';
import { MetricsService } from '../observability/metrics.service';

/**
 * Phase 10 C4 — token-bucket back-pressure for the watch daemon.
 *
 * A concrete `BudgetGuard` implementation consumed by
 * `WatchDaemonService`. Classic token-bucket per-repo:
 *
 *   - `capacity` tokens max, topping up at `refillPerSec` tokens/sec.
 *   - On each `check(repoId, pendingCount)` we refill first (elapsed
 *     since `lastRefillMs` times `refillPerSec`, clamped to capacity),
 *     then consume `pendingCount` tokens if available.
 *   - If there aren't enough tokens, we return `{ ok: false,
 *     retryAfterMs, reason: 'token-cap' }` where `retryAfterMs` is
 *     how long the caller should wait before re-trying — i.e. the
 *     time needed to accumulate the shortfall at `refillPerSec`.
 *
 * ### Config
 *
 * Per-repo overrides are looked up first, then fall back to defaults:
 *
 *   - `watch.tokenCap.capacity.<repoId>`    → capacity for that repo
 *   - `watch.tokenCap.refillPerSec.<repoId>` → refill rate for that repo
 *   - `watch.tokenCap.capacity`             → default capacity (1000)
 *   - `watch.tokenCap.refillPerSec`         → default refill (50 tok/s)
 *
 * Config is resolved lazily on first `check()` per repo and cached in
 * the bucket state — subsequent checks don't re-read config. Call
 * `resetBucket(repoId)` to force a re-read (useful in tests).
 *
 * ### Observability
 *
 * If `MetricsService` is injected the guard records:
 *
 *   - `coderover_watch_tokens_remaining{repoId}` gauge
 *     (set on every refill)
 *   - `coderover_watch_back_pressure_total{repoId}` counter
 *     (incremented on every `ok: false` decision)
 *
 * ### Test seams
 *
 * Tests can override `Date.now()` via `setNow(fn)` or construct a
 * pre-clocked instance via `TokenCapService.withClock(config, metrics,
 * now)`. Production always uses `Date.now()`.
 */
@Injectable()
export class TokenCapService implements BudgetGuard {
  private readonly buckets = new Map<string, BucketState>();
  private now: () => number = () => Date.now();

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * Build an instance with a test clock pre-wired. Intended for unit
   * tests — production should use the DI constructor.
   */
  static withClock(
    configService: ConfigService,
    metrics: MetricsService | undefined,
    now: () => number,
  ): TokenCapService {
    const svc = new TokenCapService(configService, metrics);
    svc.setNow(now);
    return svc;
  }

  /** Test-only: override the clock. */
  setNow(now: () => number): void {
    this.now = now;
  }

  /** Test-only: drop cached state for a repo so config is re-read. */
  resetBucket(repoId: string): void {
    this.buckets.delete(repoId);
  }

  async check(
    repoId: string,
    pendingCount: number,
  ): Promise<
    { ok: true } | { ok: false; retryAfterMs: number; reason?: string }
  > {
    const bucket = this.getOrCreateBucket(repoId);
    this.refill(bucket);

    // Record remaining gauge on every refill (per spec).
    this.metrics?.set(
      'coderover_watch_tokens_remaining',
      bucket.tokens,
      { repoId },
    );

    if (bucket.tokens >= pendingCount) {
      bucket.tokens -= pendingCount;
      // Gauge reflects the post-consume state as well.
      this.metrics?.set(
        'coderover_watch_tokens_remaining',
        bucket.tokens,
        { repoId },
      );
      return { ok: true };
    }

    const shortfall = pendingCount - bucket.tokens;
    const retryAfterMs = Math.ceil((shortfall / bucket.refillPerSec) * 1000);
    this.metrics?.inc('coderover_watch_back_pressure_total', { repoId });
    return { ok: false, retryAfterMs, reason: 'token-cap' };
  }

  private getOrCreateBucket(repoId: string): BucketState {
    const existing = this.buckets.get(repoId);
    if (existing) return existing;

    const capacity = this.readNumber(
      `watch.tokenCap.capacity.${repoId}`,
      `watch.tokenCap.capacity`,
      DEFAULT_CAPACITY,
    );
    const refillPerSec = this.readNumber(
      `watch.tokenCap.refillPerSec.${repoId}`,
      `watch.tokenCap.refillPerSec`,
      DEFAULT_REFILL_PER_SEC,
    );

    const bucket: BucketState = {
      tokens: capacity,
      capacity,
      refillPerSec,
      lastRefillMs: this.now(),
    };
    this.buckets.set(repoId, bucket);
    return bucket;
  }

  private refill(bucket: BucketState): void {
    const nowMs = this.now();
    const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
    if (elapsedMs === 0) return;
    const added = (elapsedMs / 1000) * bucket.refillPerSec;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + added);
    bucket.lastRefillMs = nowMs;
  }

  private readNumber(
    specificKey: string,
    fallbackKey: string,
    defaultValue: number,
  ): number {
    const specific = this.configService.get<number | string | undefined>(specificKey);
    if (specific !== undefined && specific !== null && specific !== '') {
      const n = Number(specific);
      if (Number.isFinite(n) && n > 0) return n;
    }
    const fallback = this.configService.get<number | string | undefined>(fallbackKey);
    if (fallback !== undefined && fallback !== null && fallback !== '') {
      const n = Number(fallback);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return defaultValue;
  }
}

interface BucketState {
  tokens: number;
  capacity: number;
  refillPerSec: number;
  lastRefillMs: number;
}

const DEFAULT_CAPACITY = 1000;
const DEFAULT_REFILL_PER_SEC = 50;
