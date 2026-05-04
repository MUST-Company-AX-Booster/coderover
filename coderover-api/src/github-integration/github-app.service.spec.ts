import { ConfigService } from '@nestjs/config';
import { GitHubAppService } from './github-app.service';

/**
 * Unit tests for GitHubAppService — focused on the installation-lookup
 * cache and isConfigured() guard, which is the new surface added in
 * Phase 2B. The JWT minting + Octokit calls themselves are covered by
 * jsonwebtoken / @octokit/rest's own test suites; we only assert our
 * caching/branching behavior on top.
 */
describe('GitHubAppService', () => {
  // A throwaway PEM private key generated only for tests. NEVER reuse this
  // anywhere — committing test PEMs is fine, committing real ones is not.
  // Generated with: openssl genpkey -algorithm RSA -pkcs8 -outform PEM \
  //                   -pkeyopt rsa_keygen_bits:2048 | head -c -1
  const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDExample\n-----END PRIVATE KEY-----`;

  function makeConfig(overrides: Record<string, string | undefined> = {}): ConfigService {
    const values: Record<string, string | undefined> = {
      GITHUB_APP_ID: '123456',
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
      ...overrides,
    };
    const get = jest.fn((key: string) => values[key]);
    return { get } as unknown as ConfigService;
  }

  /**
   * Subclass override for tests — bypass the real Octokit network call and
   * return scripted installation IDs (or throw 404) so cache logic can be
   * inspected in isolation.
   */
  class StubAppService extends GitHubAppService {
    public repoLookups = 0;
    public ownerLookups = 0;
    public scriptedRepoResult: number | null = 42;
    public scriptedOwnerResult: number | null = 99;
    public throwForRepo: Error | null = null;
    public throwForOwner: Error | null = null;

    protected async lookupInstallationForRepo(): Promise<number | null> {
      this.repoLookups++;
      if (this.throwForRepo) throw this.throwForRepo;
      return this.scriptedRepoResult;
    }
    protected async lookupInstallationForOwner(): Promise<number | null> {
      this.ownerLookups++;
      if (this.throwForOwner) throw this.throwForOwner;
      return this.scriptedOwnerResult;
    }
  }

  describe('isConfigured', () => {
    it('is true when both APP_ID and PRIVATE_KEY are set', () => {
      const svc = new GitHubAppService(makeConfig());
      expect(svc.isConfigured()).toBe(true);
    });

    it('is false when APP_ID is missing', () => {
      const svc = new GitHubAppService(makeConfig({ GITHUB_APP_ID: undefined }));
      expect(svc.isConfigured()).toBe(false);
    });

    it('is false when PRIVATE_KEY is missing', () => {
      const svc = new GitHubAppService(
        makeConfig({ GITHUB_APP_PRIVATE_KEY: undefined }),
      );
      expect(svc.isConfigured()).toBe(false);
    });
  });

  describe('findInstallationForRepo', () => {
    it('returns null when App is not configured (skips network)', async () => {
      const svc = new StubAppService(makeConfig({ GITHUB_APP_ID: undefined }));
      expect(await svc.findInstallationForRepo('o', 'r')).toBeNull();
      expect(svc.repoLookups).toBe(0);
    });

    it('returns the scripted installation id on first call', async () => {
      const svc = new StubAppService(makeConfig());
      svc.scriptedRepoResult = 42;
      expect(await svc.findInstallationForRepo('octocat', 'hello')).toBe(42);
    });

    it('caches the result — second call does not hit the network', async () => {
      const svc = new StubAppService(makeConfig());
      await svc.findInstallationForRepo('octocat', 'hello');
      await svc.findInstallationForRepo('octocat', 'hello');
      expect(svc.repoLookups).toBe(1);
    });

    it('treats owner/repo as case-insensitive for cache hit', async () => {
      const svc = new StubAppService(makeConfig());
      await svc.findInstallationForRepo('octocat', 'Hello');
      await svc.findInstallationForRepo('OctoCat', 'hello');
      expect(svc.repoLookups).toBe(1);
    });

    it('caches "no install" results too (null)', async () => {
      const svc = new StubAppService(makeConfig());
      svc.scriptedRepoResult = null;
      expect(await svc.findInstallationForRepo('o', 'r')).toBeNull();
      expect(await svc.findInstallationForRepo('o', 'r')).toBeNull();
      expect(svc.repoLookups).toBe(1);
    });

    it('invalidate clears the cache', async () => {
      const svc = new StubAppService(makeConfig());
      await svc.findInstallationForRepo('o', 'r');
      svc.invalidateInstallationLookupCache();
      await svc.findInstallationForRepo('o', 'r');
      expect(svc.repoLookups).toBe(2);
    });

    it('dedups concurrent in-flight lookups for the same key (no stampede)', async () => {
      // Make the underlying lookup slow so 50 callers all arrive while it
      // is still in-flight. With dedup, repoLookups must be exactly 1.
      class SlowStub extends StubAppService {
        protected async lookupInstallationForRepo(): Promise<number | null> {
          this.repoLookups++;
          await new Promise(r => setTimeout(r, 20));
          return 42;
        }
      }
      const svc = new SlowStub(makeConfig());
      const results = await Promise.all(
        Array.from({ length: 50 }, () => svc.findInstallationForRepo('octocat', 'hello')),
      );
      expect(results.every(r => r === 42)).toBe(true);
      expect(svc.repoLookups).toBe(1);
    });

    it('after an in-flight lookup completes, a later call uses the cache (still 1 lookup)', async () => {
      const svc = new StubAppService(makeConfig());
      await svc.findInstallationForRepo('octocat', 'hello');
      await svc.findInstallationForRepo('octocat', 'hello');
      await svc.findInstallationForRepo('octocat', 'hello');
      expect(svc.repoLookups).toBe(1);
    });

    it('caps cache size with FIFO eviction (oldest first)', async () => {
      // We can't easily flip the constant from the test, but we CAN write
      // 600+ unique keys and assert the map size never exceeds the cap.
      const svc = new StubAppService(makeConfig());
      svc.scriptedRepoResult = 1;
      for (let i = 0; i < 600; i++) {
        await svc.findInstallationForRepo('owner', `repo-${i}`);
      }
      // Reach into the protected cache via property access.
      const cache = (svc as unknown as {
        repoInstallationCache: Map<string, unknown>;
      }).repoInstallationCache;
      expect(cache.size).toBeLessThanOrEqual(500);
      // Oldest (repo-0) should have been evicted; newest (repo-599) retained.
      expect(cache.has('owner/repo-0')).toBe(false);
      expect(cache.has('owner/repo-599')).toBe(true);
    });
  });

  describe('findInstallationForOwner', () => {
    it('returns null when App is not configured', async () => {
      const svc = new StubAppService(
        makeConfig({ GITHUB_APP_PRIVATE_KEY: undefined }),
      );
      expect(await svc.findInstallationForOwner('octocat')).toBeNull();
      expect(svc.ownerLookups).toBe(0);
    });

    it('returns scripted result and caches', async () => {
      const svc = new StubAppService(makeConfig());
      svc.scriptedOwnerResult = 99;
      expect(await svc.findInstallationForOwner('octocat')).toBe(99);
      expect(await svc.findInstallationForOwner('octocat')).toBe(99);
      expect(svc.ownerLookups).toBe(1);
    });

    it('case-insensitive cache key', async () => {
      const svc = new StubAppService(makeConfig());
      await svc.findInstallationForOwner('OctoCat');
      await svc.findInstallationForOwner('octocat');
      expect(svc.ownerLookups).toBe(1);
    });
  });
});
