import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CacheEntry } from '../entities/cache-entry.entity';

/**
 * Phase 10 C1 — Redis-resident hash index of known cache keys per
 * ingestion run.
 *
 * Why: at ingestion-run start we need to know, per-file,
 *   "have we already cached an artifact for this content?"
 * Querying Postgres for each of 100k files misses the 10s budget on
 * cold caches. Instead, we materialize every known key into a single
 * Redis HASH keyed by run, and every per-file check becomes an HEXISTS
 * round-trip. C2 and C3 both consume this.
 *
 * Key layout:
 *   coderover:cache:index:{runId}  (HASH)
 *     field = cache_key
 *     value = '1' (presence only)
 *   TTL: 1 hour — runs are ephemeral; stale hashes auto-expire so we
 *   never leak memory if a run crashes before `clearRun`.
 */

/**
 * Minimal ioredis-shaped interface we depend on. Typing it locally
 * lets tests pass a plain mock without importing ioredis.
 */
export interface RedisLike {
  hset(key: string, ...args: (string | number)[]): Promise<number>;
  hexists(key: string, field: string): Promise<number>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  pipeline?(): {
    hset(key: string, ...args: (string | number)[]): any;
    expire(key: string, seconds: number): any;
    exec(): Promise<unknown>;
  };
}

export const CACHE_REDIS_CLIENT = 'CODEROVER_CACHE_REDIS_CLIENT';

const KEY_PREFIX = 'coderover:cache:index';
const RUN_HASH_TTL_SECONDS = 60 * 60; // 1h

@Injectable()
export class CacheHashIndexService {
  private readonly logger = new Logger(CacheHashIndexService.name);

  constructor(
    @Optional()
    @Inject(CACHE_REDIS_CLIENT)
    private readonly redis: RedisLike | null,
    @InjectRepository(CacheEntry)
    private readonly cacheRepo: Repository<CacheEntry>,
  ) {}

  private runKey(runId: string): string {
    if (!runId) throw new Error('CacheHashIndexService: runId is required');
    return `${KEY_PREFIX}:${runId}`;
  }

  /**
   * Populate the per-run Redis hash with every known cache key.
   * Source of truth is Postgres `cache_entries` (distinct cache_key).
   * Idempotent — calling it twice with the same runId is a no-op beyond
   * refreshing the TTL.
   *
   * Redis unavailable → log + continue. Callers must tolerate an
   * always-miss index; the cache degrades gracefully (every file
   * re-processed, but ingest still completes).
   */
  async loadIndex(runId: string): Promise<void> {
    const key = this.runKey(runId);
    if (!this.redis) {
      this.logger.warn(
        `Redis client not configured; cache hash index for run ${runId} will always miss`,
      );
      return;
    }

    const keys = await this.getAllCachedKeys();
    if (keys.length === 0) {
      try {
        await this.redis.expire(key, RUN_HASH_TTL_SECONDS);
      } catch {
        /* empty hash + unreachable redis is harmless */
      }
      return;
    }

    const CHUNK = 500;
    try {
      if (this.redis.pipeline) {
        for (let i = 0; i < keys.length; i += CHUNK) {
          const slice = keys.slice(i, i + CHUNK);
          const args: (string | number)[] = [];
          for (const k of slice) args.push(k, '1');
          const pipe = this.redis.pipeline();
          pipe.hset(key, ...args);
          await pipe.exec();
        }
      } else {
        for (let i = 0; i < keys.length; i += CHUNK) {
          const slice = keys.slice(i, i + CHUNK);
          const args: (string | number)[] = [];
          for (const k of slice) args.push(k, '1');
          await this.redis.hset(key, ...args);
        }
      }
      await this.redis.expire(key, RUN_HASH_TTL_SECONDS);
    } catch (err) {
      this.logger.warn(
        `loadIndex failed for run ${runId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * HEXISTS on the run hash. Returns false if Redis is unavailable —
   * callers proceed with a cold path rather than blocking ingestion.
   */
  async has(runId: string, key: string): Promise<boolean> {
    const hashKey = this.runKey(runId); // throws on empty runId
    if (!this.redis) return false;
    try {
      const res = await this.redis.hexists(hashKey, key);
      return res === 1;
    } catch (err) {
      this.logger.warn(
        `HEXISTS failed for run ${runId}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Drop the per-run hash. Called at run end; also called defensively
   * before `loadIndex` if the caller wants a clean slate.
   */
  async clearRun(runId: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(this.runKey(runId));
    } catch (err) {
      this.logger.warn(
        `clearRun failed for ${runId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Returns every distinct cache_key currently stored. Pulled out
   * as a public method so C2 can extend with filters (e.g. per-repo
   * scoping) without touching the index code.
   */
  async getAllCachedKeys(): Promise<string[]> {
    const rows: Array<{ cache_key: string }> = await this.cacheRepo
      .createQueryBuilder('c')
      .select('DISTINCT c.cache_key', 'cache_key')
      .getRawMany();
    return rows.map((r) => r.cache_key).filter(Boolean);
  }
}
