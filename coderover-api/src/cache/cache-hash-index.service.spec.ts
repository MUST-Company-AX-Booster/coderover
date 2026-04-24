import { CacheHashIndexService, RedisLike } from './cache-hash-index.service';

/**
 * Phase 10 C1 — CacheHashIndexService tests.
 *
 * Covered:
 *   - loadIndex populates the Redis hash + sets TTL
 *   - loadIndex is tolerant of Redis unavailability (degrades silently)
 *   - has() returns true for populated keys, false otherwise
 *   - clearRun removes the hash
 *   - requires runId
 */

function makeRedis() {
  // Simple in-memory stand-in shaped like the RedisLike interface.
  const hashes = new Map<string, Map<string, string>>();
  const ttls = new Map<string, number>();

  const redis: RedisLike & {
    hashes: typeof hashes;
    ttls: typeof ttls;
  } = {
    hashes,
    ttls,
    async hset(key, ...args) {
      let map = hashes.get(key);
      if (!map) {
        map = new Map();
        hashes.set(key, map);
      }
      let added = 0;
      for (let i = 0; i < args.length; i += 2) {
        const f = String(args[i]);
        const v = String(args[i + 1]);
        if (!map.has(f)) added += 1;
        map.set(f, v);
      }
      return added;
    },
    async hexists(key, field) {
      return hashes.get(key)?.has(field) ? 1 : 0;
    },
    async del(...keys) {
      let n = 0;
      for (const k of keys) {
        if (hashes.delete(k)) n += 1;
        ttls.delete(k);
      }
      return n;
    },
    async expire(key, seconds) {
      if (!hashes.has(key)) {
        // Match Redis semantics loosely — expire returns 0 if key absent.
        return 0;
      }
      ttls.set(key, seconds);
      return 1;
    },
  };
  return redis;
}

function makeRepoWithKeys(keys: string[]) {
  return {
    createQueryBuilder: () => ({
      select: () => ({
        getRawMany: async () => keys.map((k) => ({ cache_key: k })),
      }),
    }),
  } as any;
}

describe('CacheHashIndexService', () => {
  it('loadIndex populates the run hash and has() returns true for known keys', async () => {
    const redis = makeRedis();
    const keys = ['k1', 'k2', 'k3'];
    const svc = new CacheHashIndexService(redis, makeRepoWithKeys(keys));

    await svc.loadIndex('run-1');

    for (const k of keys) {
      expect(await svc.has('run-1', k)).toBe(true);
    }
    expect(await svc.has('run-1', 'missing-key')).toBe(false);
    // TTL was set.
    expect(redis.ttls.get('coderover:cache:index:run-1')).toBe(3600);
  });

  it('clearRun removes the per-run hash', async () => {
    const redis = makeRedis();
    const svc = new CacheHashIndexService(redis, makeRepoWithKeys(['k1']));

    await svc.loadIndex('run-2');
    expect(await svc.has('run-2', 'k1')).toBe(true);

    await svc.clearRun('run-2');

    expect(redis.hashes.has('coderover:cache:index:run-2')).toBe(false);
    expect(await svc.has('run-2', 'k1')).toBe(false);
  });

  it('has() returns false when Redis is unavailable', async () => {
    const svc = new CacheHashIndexService(null, makeRepoWithKeys([]));
    expect(await svc.has('run-x', 'k1')).toBe(false);
  });

  it('loadIndex degrades silently when Redis is null', async () => {
    const svc = new CacheHashIndexService(null, makeRepoWithKeys(['k1']));
    await expect(svc.loadIndex('run-x')).resolves.toBeUndefined();
  });

  it('throws on empty runId', async () => {
    const svc = new CacheHashIndexService(makeRedis(), makeRepoWithKeys([]));
    await expect(svc.has('', 'k')).rejects.toThrow(/runId/);
  });

  it('handles an empty keys list without crashing', async () => {
    const redis = makeRedis();
    const svc = new CacheHashIndexService(redis, makeRepoWithKeys([]));
    await expect(svc.loadIndex('empty')).resolves.toBeUndefined();
    expect(await svc.has('empty', 'anything')).toBe(false);
  });

  it('is idempotent across repeated loadIndex calls', async () => {
    const redis = makeRedis();
    const svc = new CacheHashIndexService(redis, makeRepoWithKeys(['k1', 'k2']));
    await svc.loadIndex('run-3');
    await svc.loadIndex('run-3');
    expect(await svc.has('run-3', 'k1')).toBe(true);
    expect(redis.hashes.get('coderover:cache:index:run-3')?.size).toBe(2);
  });
});
