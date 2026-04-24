import { Repository } from 'typeorm';
import { CacheEntry } from '../entities/cache-entry.entity';
import { ContentCacheService } from './content-cache.service';
import { BlobStore, buildBlobPath } from './blob-store';

/**
 * Phase 10 C1 — ContentCacheService tests.
 *
 * Covered:
 *   - computeKey: deterministic; normalizes line endings; strips BOM
 *   - put → get round-trip
 *   - get miss returns null
 *   - invalidate clears every artifact kind for the key
 *   - missing blob with present metadata → null + auto-cleanup
 */

function makeRepo(): jest.Mocked<Repository<CacheEntry>> & {
  rows: Map<string, CacheEntry>;
} {
  const rows = new Map<string, CacheEntry>();
  const keyOf = (e: Partial<CacheEntry>) =>
    `${e.cacheKey}::${e.artifactKind}`;

  const repo: any = {
    rows,
    create: (obj: Partial<CacheEntry>) => ({
      ...obj,
      id: obj.id ?? `id-${rows.size + 1}`,
      createdAt: obj['createdAt'] ?? new Date(),
      lastAccessedAt: obj.lastAccessedAt ?? new Date(),
    }),
    save: jest.fn(async (entity: CacheEntry) => {
      const stored: CacheEntry = {
        ...entity,
        id: entity.id ?? `id-${rows.size + 1}`,
        createdAt: entity.createdAt ?? new Date(),
        lastAccessedAt: entity.lastAccessedAt ?? new Date(),
        orgId: entity.orgId ?? null,
      } as CacheEntry;
      rows.set(keyOf(stored), stored);
      return stored;
    }),
    findOne: jest.fn(async ({ where }: any) => {
      const k = keyOf(where);
      return rows.get(k) ?? null;
    }),
    find: jest.fn(async ({ where }: any = {}) => {
      const out: CacheEntry[] = [];
      for (const r of rows.values()) {
        if (where?.cacheKey && r.cacheKey !== where.cacheKey) continue;
        if (where?.artifactKind && r.artifactKind !== where.artifactKind) continue;
        out.push(r);
      }
      return out;
    }),
    update: jest.fn(async (where: any, patch: any) => {
      for (const [k, r] of rows) {
        if (where.cacheKey && r.cacheKey !== where.cacheKey) continue;
        if (where.artifactKind && r.artifactKind !== where.artifactKind) continue;
        rows.set(k, { ...r, ...patch });
      }
      return { affected: 1 } as any;
    }),
    delete: jest.fn(async (where: any) => {
      let n = 0;
      for (const [k, r] of rows) {
        if (where.id && r.id !== where.id) continue;
        if (where.cacheKey && r.cacheKey !== where.cacheKey) continue;
        if (where.artifactKind && r.artifactKind !== where.artifactKind) continue;
        rows.delete(k);
        n += 1;
      }
      return { affected: n } as any;
    }),
  };
  return repo;
}

function makeBlobStore(): BlobStore & { blobs: Map<string, Buffer> } {
  const blobs = new Map<string, Buffer>();
  return {
    blobs,
    get: async (p: string) => blobs.get(p) ?? null,
    put: async (p: string, data: Buffer) => {
      blobs.set(p, data);
    },
    delete: async (p: string) => {
      blobs.delete(p);
    },
    exists: async (p: string) => blobs.has(p),
  } as any;
}

describe('ContentCacheService', () => {
  let repo: ReturnType<typeof makeRepo>;
  let blobStore: ReturnType<typeof makeBlobStore>;
  let svc: ContentCacheService;

  beforeEach(() => {
    repo = makeRepo();
    blobStore = makeBlobStore();
    svc = new ContentCacheService(repo as any, blobStore as any);
  });

  describe('computeKey', () => {
    it('produces the same hash for LF / CRLF / CR variants', () => {
      const lf = svc.computeKey('line1\nline2\n');
      const crlf = svc.computeKey('line1\r\nline2\r\n');
      const cr = svc.computeKey('line1\rline2\r');
      expect(lf).toBe(crlf);
      expect(lf).toBe(cr);
    });

    it('strips a leading UTF-8 BOM before hashing', () => {
      const bom = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('hello', 'utf8')]);
      const plain = 'hello';
      expect(svc.computeKey(bom)).toBe(svc.computeKey(plain));
    });

    it('is deterministic across calls', () => {
      const a = svc.computeKey('const x = 1;\n');
      const b = svc.computeKey('const x = 1;\n');
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces distinct hashes for distinct content', () => {
      expect(svc.computeKey('a')).not.toBe(svc.computeKey('b'));
    });

    it('accepts Buffer input identically to string', () => {
      const s = 'foo\nbar\n';
      expect(svc.computeKey(s)).toBe(svc.computeKey(Buffer.from(s, 'utf8')));
    });
  });

  describe('put / get', () => {
    it('round-trips a JSON-serializable artifact', async () => {
      const key = svc.computeKey('source code\n');
      const payload = { symbols: ['foo', 'bar'], count: 2 };

      await svc.put(key, 'symbols', payload);
      const got = await svc.get<typeof payload>(key, 'symbols');

      expect(got).toEqual(payload);
      expect(blobStore.blobs.size).toBe(1);
      expect(blobStore.blobs.has(buildBlobPath('symbols', key))).toBe(true);
    });

    it('returns null on miss', async () => {
      const out = await svc.get('deadbeef'.repeat(8), 'ast');
      expect(out).toBeNull();
    });

    it('overwrites on second put with same (key, kind)', async () => {
      const key = svc.computeKey('x');
      await svc.put(key, 'ast', { v: 1 });
      await svc.put(key, 'ast', { v: 2 });
      const got = await svc.get<{ v: number }>(key, 'ast');
      expect(got).toEqual({ v: 2 });
      expect(repo.rows.size).toBe(1); // still one row
    });

    it('keeps (key, kind) pairs independent', async () => {
      const key = svc.computeKey('x');
      await svc.put(key, 'ast', { a: 1 });
      await svc.put(key, 'embeddings', [0.1, 0.2]);
      expect(await svc.get(key, 'ast')).toEqual({ a: 1 });
      expect(await svc.get(key, 'embeddings')).toEqual([0.1, 0.2]);
      expect(await svc.get(key, 'symbols')).toBeNull();
    });

    it('auto-cleans metadata rows whose blob vanished', async () => {
      const key = svc.computeKey('x');
      await svc.put(key, 'ast', { a: 1 });
      // simulate an out-of-band blob deletion (eviction crash mid-sweep)
      blobStore.blobs.clear();
      const out = await svc.get(key, 'ast');
      expect(out).toBeNull();
      expect(repo.rows.size).toBe(0);
    });

    it('touches last_accessed_at on a hit', async () => {
      const key = svc.computeKey('x');
      await svc.put(key, 'ast', { a: 1 });
      const before = [...repo.rows.values()][0].lastAccessedAt;
      await new Promise((r) => setTimeout(r, 5));
      await svc.get(key, 'ast');
      const after = [...repo.rows.values()][0].lastAccessedAt;
      expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });

  describe('invalidate', () => {
    it('removes every artifact kind for a key', async () => {
      const key = svc.computeKey('x');
      await svc.put(key, 'ast', { a: 1 });
      await svc.put(key, 'embeddings', [1]);
      await svc.put(key, 'symbols', ['s']);
      await svc.put(key, 'graph_delta', { edges: [] });

      await svc.invalidate(key);

      expect(repo.rows.size).toBe(0);
      expect(blobStore.blobs.size).toBe(0);
      for (const kind of ['ast', 'embeddings', 'symbols', 'graph_delta'] as const) {
        expect(await svc.get(key, kind)).toBeNull();
      }
    });

    it('leaves other keys untouched', async () => {
      const k1 = svc.computeKey('a');
      const k2 = svc.computeKey('b');
      await svc.put(k1, 'ast', { n: 1 });
      await svc.put(k2, 'ast', { n: 2 });
      await svc.invalidate(k1);
      expect(await svc.get(k1, 'ast')).toBeNull();
      expect(await svc.get(k2, 'ast')).toEqual({ n: 2 });
    });

    it('is a no-op for unknown keys', async () => {
      await expect(svc.invalidate('nope')).resolves.toBeUndefined();
    });
  });
});
