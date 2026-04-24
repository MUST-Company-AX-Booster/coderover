import { ConfigService } from '@nestjs/config';
import { CacheEntry } from '../entities/cache-entry.entity';
import { BlobStore } from './blob-store';
import { CacheEvictionService } from './cache-eviction.service';

/**
 * Phase 10 C1 — CacheEvictionService tests.
 *
 * Covered:
 *   - evictExpired removes rows older than the TTL, leaves fresh rows
 *   - evictExpired deletes the associated blob
 *   - evictToSize evicts oldest-accessed first until under the cap
 *   - evictToSize is a no-op when already under the cap
 *   - sweep failure on a missing blob still drops the metadata row
 *
 * We avoid the full TypeORM Repository surface by using an in-memory
 * stand-in that implements only the methods the service calls.
 */

type Row = CacheEntry;

function makeRepo(initial: Row[] = []) {
  const rows: Row[] = [...initial];
  let lastQuery: any;

  const matches = (row: Row, where: any): boolean => {
    if (!where) return true;
    if (where.id && row.id !== where.id) return false;
    if (where.cacheKey && row.cacheKey !== where.cacheKey) return false;
    if (where.artifactKind && row.artifactKind !== where.artifactKind) return false;
    if (where.lastAccessedAt) {
      // TypeORM FindOperator — check type + value.
      const op = where.lastAccessedAt;
      if (op._type === 'lessThan') {
        if (row.lastAccessedAt.getTime() >= new Date(op._value).getTime())
          return false;
      }
    }
    return true;
  };

  const repo: any = {
    rows,
    find: jest.fn(async (opts: any = {}) => {
      let out = rows.filter((r) => matches(r, opts.where));
      if (opts.order?.lastAccessedAt === 'ASC') {
        out = out.sort(
          (a, b) => a.lastAccessedAt.getTime() - b.lastAccessedAt.getTime(),
        );
      }
      if (opts.skip) out = out.slice(opts.skip);
      if (opts.take) out = out.slice(0, opts.take);
      return out;
    }),
    delete: jest.fn(async (where: any) => {
      let n = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (matches(rows[i], where)) {
          rows.splice(i, 1);
          n += 1;
        }
      }
      return { affected: n };
    }),
    createQueryBuilder: (_alias: string) => {
      const _state: any = {};
      const qb: any = {
        select: (_expr: string, _alias: string) => qb,
        getRawOne: async () => {
          const sum = rows.reduce((a, r) => a + Number(r.sizeBytes), 0);
          return { sum: String(sum) };
        },
      };
      lastQuery = qb;
      return qb;
    },
    _lastQuery: () => lastQuery,
  };
  return repo;
}

function makeBlobStore(): BlobStore & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    get: async () => null,
    put: async () => {},
    delete: async (p: string) => {
      deleted.push(p);
    },
    exists: async () => false,
  } as any;
}

function makeConfig(overrides: Record<string, any> = {}) {
  return {
    get: (k: string, def?: any) => (k in overrides ? overrides[k] : def),
  } as unknown as ConfigService;
}

function row(partial: Partial<Row>): Row {
  return {
    id: partial.id ?? `id-${Math.random().toString(16).slice(2)}`,
    cacheKey: partial.cacheKey ?? 'k',
    artifactKind: partial.artifactKind ?? 'ast',
    blobPath: partial.blobPath ?? 'cache/ast/xx/yy/k.bin',
    sizeBytes: partial.sizeBytes ?? 1000,
    createdAt: partial.createdAt ?? new Date(),
    lastAccessedAt: partial.lastAccessedAt ?? new Date(),
    orgId: partial.orgId ?? null,
  } as Row;
}

describe('CacheEvictionService', () => {
  describe('evictExpired', () => {
    it('removes rows older than the TTL and deletes their blobs', async () => {
      const now = Date.now();
      const old = new Date(now - 100 * 24 * 60 * 60 * 1000); // 100 days old
      const fresh = new Date(now - 10 * 24 * 60 * 60 * 1000); // 10 days old
      const repo = makeRepo([
        row({ id: 'stale-1', lastAccessedAt: old, blobPath: 'cache/ast/aa/bb/stale.bin', sizeBytes: 2048 }),
        row({ id: 'fresh-1', lastAccessedAt: fresh, blobPath: 'cache/ast/cc/dd/fresh.bin', sizeBytes: 4096 }),
      ]);
      const blobStore = makeBlobStore();
      const svc = new CacheEvictionService(repo, blobStore, makeConfig());

      const res = await svc.evictExpired(90);

      expect(res.count).toBe(1);
      expect(res.freed).toBe(2048);
      expect(repo.rows.length).toBe(1);
      expect(repo.rows[0].id).toBe('fresh-1');
      expect(blobStore.deleted).toEqual(['cache/ast/aa/bb/stale.bin']);
    });

    it('is a no-op when nothing has expired', async () => {
      const repo = makeRepo([row({ lastAccessedAt: new Date() })]);
      const blobStore = makeBlobStore();
      const svc = new CacheEvictionService(repo, blobStore, makeConfig());

      const res = await svc.evictExpired(90);

      expect(res.count).toBe(0);
      expect(res.freed).toBe(0);
      expect(repo.rows.length).toBe(1);
    });

    it('drops the metadata row even if the blob delete fails', async () => {
      const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
      const repo = makeRepo([row({ id: 'x', lastAccessedAt: old, sizeBytes: 500 })]);
      const blobStore: BlobStore = {
        get: async () => null,
        put: async () => {},
        delete: async () => {
          throw new Error('S3 unreachable');
        },
        exists: async () => false,
      };
      const svc = new CacheEvictionService(repo, blobStore as any, makeConfig());

      const res = await svc.evictExpired(90);

      expect(res.count).toBe(1);
      expect(res.freed).toBe(500);
      expect(repo.rows.length).toBe(0);
    });
  });

  describe('evictToSize', () => {
    it('evicts oldest-accessed rows until under the cap', async () => {
      const t = (daysAgo: number) =>
        new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
      const repo = makeRepo([
        row({ id: 'oldest', lastAccessedAt: t(30), sizeBytes: 100 }),
        row({ id: 'middle', lastAccessedAt: t(20), sizeBytes: 100 }),
        row({ id: 'newest', lastAccessedAt: t(1), sizeBytes: 100 }),
      ]);
      const blobStore = makeBlobStore();
      const svc = new CacheEvictionService(repo, blobStore, makeConfig());

      // Total = 300B; cap 150B → must evict at least 150B (2 oldest rows).
      const res = await svc.evictToSize(150);

      expect(res.count).toBe(2);
      expect(res.freed).toBe(200);
      expect(repo.rows.map((r: Row) => r.id)).toEqual(['newest']);
    });

    it('is a no-op when total is already under the cap', async () => {
      const repo = makeRepo([row({ sizeBytes: 100 }), row({ sizeBytes: 100 })]);
      const blobStore = makeBlobStore();
      const svc = new CacheEvictionService(repo, blobStore, makeConfig());

      const res = await svc.evictToSize(10 * 1024);

      expect(res.count).toBe(0);
      expect(res.freed).toBe(0);
      expect(repo.rows.length).toBe(2);
    });
  });

  describe('lifecycle', () => {
    it('does not schedule the sweep interval when NODE_ENV=test', () => {
      const repo = makeRepo();
      const blobStore = makeBlobStore();
      const svc = new CacheEvictionService(
        repo,
        blobStore,
        makeConfig({ NODE_ENV: 'test' }),
      );
      // Should be a no-op — no timer leaked.
      svc.onModuleInit();
      // @ts-expect-error accessing private for assertion
      expect(svc.timer).toBeNull();
      svc.onModuleDestroy();
    });

    it('does not schedule when CACHE_EVICTION_ENABLED=false', () => {
      const repo = makeRepo();
      const blobStore = makeBlobStore();
      const svc = new CacheEvictionService(
        repo,
        blobStore,
        makeConfig({ NODE_ENV: 'development', CACHE_EVICTION_ENABLED: 'false' }),
      );
      svc.onModuleInit();
      // @ts-expect-error accessing private
      expect(svc.timer).toBeNull();
      svc.onModuleDestroy();
    });
  });
});
