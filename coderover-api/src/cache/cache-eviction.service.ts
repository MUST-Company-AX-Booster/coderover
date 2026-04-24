import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { CacheEntry } from '../entities/cache-entry.entity';
import { BLOB_STORE, BlobStore } from './blob-store';

/**
 * Phase 10 C1 — cache eviction.
 *
 * Two policies, both enabled by default:
 *
 *   1. 90-day TTL sweep — anything not accessed in 90 days is gone.
 *   2. Size-based LRU — when total cache size exceeds the configured
 *      cap (`CACHE_MAX_BYTES`, default 50GB), evict oldest-accessed
 *      first until we're back under the cap.
 *
 * Scheduling: a minimal `setInterval` loop that ticks once every 24h
 * (default). We don't pull in `@nestjs/schedule` for a single cron —
 * the ioredis/typeorm surface is already enough runtime weight.
 * Disable with `CACHE_EVICTION_ENABLED=false`; tests set that flag so
 * no background work bleeds into the suite.
 *
 * Eviction is idempotent: each sweep re-reads from Postgres, deletes
 * the blob (best-effort), then deletes the metadata row. A partial
 * failure mid-sweep leaves the remaining rows for the next tick.
 */

const DEFAULT_TTL_DAYS = 90;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024 * 1024; // 50GB
const DEFAULT_TICK_MS = 24 * 60 * 60 * 1000; // 24h

@Injectable()
export class CacheEvictionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheEvictionService.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    @InjectRepository(CacheEntry)
    private readonly cacheRepo: Repository<CacheEntry>,
    @Inject(BLOB_STORE) private readonly blobStore: BlobStore,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const enabled = this.readBoolEnv('CACHE_EVICTION_ENABLED', true);
    if (!enabled) {
      this.logger.log('cache eviction disabled via CACHE_EVICTION_ENABLED');
      return;
    }

    // Don't auto-schedule under NODE_ENV=test — tests drive eviction
    // explicitly. Prevents the interval from leaking into jest's
    // open-handle warnings.
    if ((this.config.get<string>('NODE_ENV') ?? process.env.NODE_ENV) === 'test') {
      return;
    }

    const tickMs =
      this.config.get<number>('CACHE_EVICTION_TICK_MS') ?? DEFAULT_TICK_MS;

    this.timer = setInterval(() => {
      void this.runSweep();
    }, tickMs);
    // Don't pin the event loop open just for eviction.
    this.timer.unref?.();
    this.logger.log(`cache eviction scheduled every ${tickMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run both sweeps back-to-back. `inFlight` guards against a second
   * tick firing before the previous one finished (a very slow blob
   * store could cause that).
   */
  async runSweep(): Promise<void> {
    if (this.inFlight) {
      this.logger.debug('eviction sweep already in flight, skipping');
      return this.inFlight;
    }
    this.inFlight = (async () => {
      try {
        const ttlDays =
          this.config.get<number>('CACHE_TTL_DAYS') ?? DEFAULT_TTL_DAYS;
        const maxBytes =
          this.config.get<number>('CACHE_MAX_BYTES') ?? DEFAULT_MAX_BYTES;
        const expired = await this.evictExpired(ttlDays);
        const lru = await this.evictToSize(maxBytes);
        this.logger.log(
          `eviction sweep: ttl=${expired.count} rows / ${expired.freed}B, ` +
            `lru=${lru.count} rows / ${lru.freed}B`,
        );
      } catch (err) {
        this.logger.error(
          `eviction sweep failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /**
   * Delete every row whose `last_accessed_at` is older than
   * `ttlDays`. Default 90 days per plan.
   */
  async evictExpired(
    ttlDays: number = DEFAULT_TTL_DAYS,
  ): Promise<{ freed: number; count: number }> {
    const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);
    const victims = await this.cacheRepo.find({
      where: { lastAccessedAt: LessThan(cutoff) },
    });
    return this.deleteRows(victims);
  }

  /**
   * LRU eviction: if total cache size exceeds `maxBytesTotal`, delete
   * oldest-accessed rows until we're under the cap.
   */
  async evictToSize(
    maxBytesTotal: number,
  ): Promise<{ freed: number; count: number }> {
    const total = await this.totalBytes();
    if (total <= maxBytesTotal) return { freed: 0, count: 0 };

    let overshoot = total - maxBytesTotal;
    const victims: CacheEntry[] = [];

    // Pull oldest rows in ascending order of last_accessed_at. Page
    // through so we don't load the full table for a small overshoot.
    const PAGE = 500;
    let offset = 0;
    while (overshoot > 0) {
      const page = await this.cacheRepo.find({
        order: { lastAccessedAt: 'ASC' },
        take: PAGE,
        skip: offset,
      });
      if (page.length === 0) break;
      for (const row of page) {
        victims.push(row);
        overshoot -= Number(row.sizeBytes);
        if (overshoot <= 0) break;
      }
      offset += page.length;
      if (page.length < PAGE) break;
    }

    return this.deleteRows(victims);
  }

  private async totalBytes(): Promise<number> {
    const res: { sum: string | null } | undefined = await this.cacheRepo
      .createQueryBuilder('c')
      .select('COALESCE(SUM(c.size_bytes), 0)', 'sum')
      .getRawOne();
    return Number(res?.sum ?? 0);
  }

  private async deleteRows(
    rows: CacheEntry[],
  ): Promise<{ freed: number; count: number }> {
    let freed = 0;
    let count = 0;
    for (const row of rows) {
      try {
        await this.blobStore.delete(row.blobPath);
      } catch (err) {
        // Blob gone already → still drop metadata.
        this.logger.debug(
          `blob delete during eviction failed for ${row.blobPath}: ${(err as Error).message}`,
        );
      }
      try {
        await this.cacheRepo.delete({ id: row.id });
        freed += Number(row.sizeBytes);
        count += 1;
      } catch (err) {
        this.logger.warn(
          `metadata delete during eviction failed for ${row.id}: ${(err as Error).message}`,
        );
      }
    }
    return { freed, count };
  }

  private readBoolEnv(name: string, defaultValue: boolean): boolean {
    const raw =
      this.config.get<string>(name) ?? process.env[name] ?? undefined;
    if (raw === undefined) return defaultValue;
    return !/^(false|0|no|off)$/i.test(raw);
  }
}
