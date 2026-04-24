import { Module, Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheEntry } from '../entities/cache-entry.entity';
import {
  BLOB_STORE,
  BlobStore,
  LocalFsBlobStore,
  S3BlobStore,
  blobStoreFromEnv,
} from './blob-store';
import {
  CACHE_REDIS_CLIENT,
  CacheHashIndexService,
  RedisLike,
} from './cache-hash-index.service';
import { CacheEvictionService } from './cache-eviction.service';
import { ContentCacheService } from './content-cache.service';

/**
 * Phase 10 C1 — Cache module wiring.
 *
 * Exports:
 *   - ContentCacheService     (get / put / invalidate)
 *   - CacheHashIndexService   (Redis-resident per-run hash index)
 *   - CacheEvictionService    (LRU + 90-day TTL sweep)
 *
 * The BlobStore provider picks local FS vs S3 based on
 * `CODEROVER_CACHE_BACKEND`; see `blobStoreFromEnv`.
 *
 * The Redis client for the hash index is provided lazily: if ioredis
 * is installed and `REDIS_HOST` is set, we connect once; otherwise the
 * provider returns `null` and the hash index logs a warning + degrades
 * to always-miss. Consumers are required to tolerate that.
 *
 * C2 (incremental ingestion) and C3 (watch daemon) will import this
 * module and consume `ContentCacheService` — no other cache entry
 * point exists.
 */

const blobStoreProvider: Provider = {
  provide: BLOB_STORE,
  inject: [ConfigService],
  useFactory: (config: ConfigService): BlobStore => blobStoreFromEnv(config),
};

const redisClientProvider: Provider = {
  provide: CACHE_REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): RedisLike | null => {
    // Tests run without Redis — don't attempt a connection.
    if ((config.get<string>('NODE_ENV') ?? process.env.NODE_ENV) === 'test') {
      return null;
    }

    let IoRedis: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      IoRedis = require('ioredis');
    } catch {
      // ioredis is in package.json, so this should not happen in prod.
      // Fail soft rather than crash the app if someone vendors without it.
      return null;
    }

    const host = config.get<string>('REDIS_HOST', 'localhost');
    const port = config.get<number>('REDIS_PORT', 6380);
    // ioredis default export shape — handle both `new Redis(...)` and
    // the CommonJS `.default` case depending on how it's bundled.
    const Ctor = IoRedis.default ?? IoRedis;
    const client = new Ctor({
      host,
      port,
      lazyConnect: true,
      // Don't retry forever — cache is best-effort, not critical path.
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    });
    // Swallow connect errors to the logger; every call site already
    // tolerates a dead Redis.
    client.on?.('error', (_err: Error) => {
      /* logged in services on actual call */
    });
    return client as RedisLike;
  },
};

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([CacheEntry])],
  providers: [
    blobStoreProvider,
    redisClientProvider,
    ContentCacheService,
    CacheHashIndexService,
    CacheEvictionService,
  ],
  exports: [
    ContentCacheService,
    CacheHashIndexService,
    CacheEvictionService,
    BLOB_STORE,
  ],
})
export class CacheModule {}

// Re-export the pieces consumers need to import by name without
// having to know the internal file layout.
export {
  ContentCacheService,
  CacheHashIndexService,
  CacheEvictionService,
  LocalFsBlobStore,
  S3BlobStore,
  BLOB_STORE,
  CACHE_REDIS_CLIENT,
};
export type { BlobStore, RedisLike };
export { ArtifactKind, ARTIFACT_KINDS, isArtifactKind } from './types';
