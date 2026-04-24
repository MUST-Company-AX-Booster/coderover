/**
 * Disk-backed catalog cache for remote-mode MCP transports.
 *
 * Each client cold-start otherwise hits `GET /mcp/capabilities` and
 * `POST /mcp` (tools/list) — two round-trips to the CodeRover API
 * before the agent sees any CodeRover tool. If the API is reachable
 * these caches are a small latency win. If the API is briefly
 * unavailable (deploy rollover, DNS blip, laptop on the subway) the
 * cache is the difference between "every CodeRover tool disappears
 * from the agent" and "tools keep working against the last-known
 * catalog until the backend comes back".
 *
 * Strategy
 * --------
 * - Cache is namespaced by `sha256(apiUrl).slice(0,16)` so different
 *   CodeRover deployments on the same machine never collide. Lives
 *   under `~/.coderover/remote-catalog-<sha>.json` alongside the
 *   local-mode DBs.
 * - Cache content: `{apiUrl, capabilities, tools, fetchedAt, writtenBy}`.
 * - On every successful `getCapabilities()` / `listTools()` the live
 *   response overwrites the cache. Stale entries are never served
 *   when the live fetch works — disk cache is strictly a fallback.
 * - On HTTP failure the transport reads the cache (if any) and uses
 *   it, logging a warning on the injected logger so the user knows
 *   they're running offline.
 *
 * Why a plain JSON file and not SQLite: remote-mode installs don't
 * load better-sqlite3 today (that's a local-mode concern). Keeping
 * the cache in JSON keeps the remote-mode install surface clean.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { BackendCapabilities, McpTool } from '../protocol';

export interface CachedCatalog {
  /** Absolute URL the cache was captured against. Round-trip guard. */
  apiUrl: string;
  /** Backend capabilities as returned by `GET /mcp/capabilities`. */
  capabilities: BackendCapabilities;
  /** Tool descriptors as returned by the last successful `tools/list`. */
  tools: McpTool[];
  /** Epoch ms when the cache was written. */
  fetchedAt: number;
  /** `@coderover/mcp` version that produced the cache. */
  writtenBy: string;
}

export interface CapabilitiesCacheOptions {
  /** Override the home dir. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Resolve writtenBy without reading package.json. Defaults to the package version. */
  packageVersion?: string;
  /** Clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Disk-backed capabilities cache. Construct once and pass to
 * {@link RemoteTransport} via its `cache` option.
 */
export class CapabilitiesCache {
  private readonly homeDir: string;
  private readonly packageVersion: string;
  private readonly now: () => number;

  constructor(opts: CapabilitiesCacheOptions = {}) {
    this.homeDir = opts.homeDir ?? os.homedir();
    this.packageVersion = opts.packageVersion ?? resolvePackageVersion();
    this.now = opts.now ?? Date.now;
  }

  /** Absolute path to the cache file for a given API URL. */
  pathFor(apiUrl: string): string {
    const sha = crypto
      .createHash('sha256')
      .update(normalizeApiUrl(apiUrl))
      .digest('hex')
      .slice(0, 16);
    return path.join(this.homeDir, '.coderover', `remote-catalog-${sha}.json`);
  }

  /**
   * Read the cached catalog for `apiUrl` or `null` if nothing has been
   * cached yet / the file is malformed / the stored apiUrl doesn't
   * match (stale sha collision guard).
   */
  read(apiUrl: string): CachedCatalog | null {
    const p = this.pathFor(apiUrl);
    let raw: string;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<CachedCatalog>;
      if (
        typeof parsed.apiUrl !== 'string' ||
        parsed.apiUrl !== normalizeApiUrl(apiUrl) ||
        typeof parsed.fetchedAt !== 'number' ||
        !parsed.capabilities ||
        !Array.isArray(parsed.tools)
      ) {
        return null;
      }
      return parsed as CachedCatalog;
    } catch {
      return null;
    }
  }

  /**
   * Overwrite the cache for `apiUrl`. Merges: either field may be
   * omitted and we'll preserve the existing value from the prior
   * cache entry. That way `getCapabilities()` and `listTools()` can
   * each refresh only their own slice without wiping the other.
   */
  write(
    apiUrl: string,
    patch: { capabilities?: BackendCapabilities; tools?: McpTool[] },
  ): void {
    const p = this.pathFor(apiUrl);
    const prior = this.read(apiUrl);
    const next: CachedCatalog = {
      apiUrl: normalizeApiUrl(apiUrl),
      capabilities: patch.capabilities ?? prior?.capabilities ?? {
        version: 'unknown',
        tools: [],
        features: { confidence_tags: false, incremental_cache: false },
      },
      tools: patch.tools ?? prior?.tools ?? [],
      fetchedAt: this.now(),
      writtenBy: this.packageVersion,
    };
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(next, null, 2) + '\n', 'utf8');
    } catch {
      // Cache write failures are non-fatal — the transport still has
      // the in-memory copy for this process. Surfacing a stderr line
      // here would be too noisy; callers can audit via `coderover
      // list` (local-mode DBs) or by checking the file directly.
    }
  }

  /** Delete the cache for a single `apiUrl`. */
  clear(apiUrl: string): void {
    try {
      fs.rmSync(this.pathFor(apiUrl), { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Collapse trivial URL variations so a user who typed
 * `https://foo.com` and `https://foo.com/` gets the same cache entry.
 */
function normalizeApiUrl(apiUrl: string): string {
  return apiUrl.trim().replace(/\/+$/, '');
}

function resolvePackageVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
