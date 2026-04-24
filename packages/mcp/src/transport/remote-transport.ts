/**
 * RemoteTransport
 * ──────────────────────────────────────────────────────────────────────────────
 * Speaks HTTPS to a running CodeRover API.
 *
 * The backend already implements MCP JSON-RPC at `POST /mcp` (see
 * `coderover-api/src/mcp/mcp-protocol.controller.ts`). Our job is mostly to
 * proxy `tools/list` and `tools/call` through that endpoint, plus hit the
 * new `GET /mcp/capabilities` for the version handshake.
 *
 * Tool name mapping: the outside world (Claude Code et al.) sees the
 * externally advertised names (`search_code`, `find_symbol`, ...) while the
 * backend uses its historical names (`search_codebase`, ...). We translate
 * on the way in and out so renames on either side stay isolated.
 */

import {
  BackendCapabilities,
  McpTool,
  McpToolResult,
  MIN_BACKEND_VERSION,
  RpcErrorCode,
  compareVersions,
} from '../protocol';
import type { Transport } from './transport';
import type { HttpClient } from './http-client';
import type { CapabilitiesCache } from './capabilities-cache';

/**
 * External MCP name → backend tool name.
 * The backend's historical naming stays intact; the MCP surface stays stable.
 */
export const TOOL_NAME_MAP: Record<string, string> = {
  search_code: 'search_codebase',
  find_symbol: 'find_symbol',
  find_dependencies: 'find_dependencies',
  get_file: 'get_file',
};

/** Reverse map — backend name → external name (only tools we expose). */
export const REVERSE_TOOL_NAME_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(TOOL_NAME_MAP).map(([k, v]) => [v, k]),
);

/** Tools we commit to exposing in MCP surface. Drives `tools/list`. */
export const EXPOSED_TOOLS = Object.keys(TOOL_NAME_MAP);

export class CapabilityMismatchError extends Error {
  readonly code = RpcErrorCode.CapabilityMismatch;
  constructor(
    readonly backendVersion: string,
    readonly minRequired: string,
  ) {
    super(
      `CodeRover backend v${backendVersion} is older than the minimum required v${minRequired}. ` +
        `Upgrade the backend or downgrade @coderover/mcp.`,
    );
    this.name = 'CapabilityMismatchError';
  }
}

export class BackendError extends Error {
  readonly code = RpcErrorCode.BackendUnreachable;
  constructor(message: string) {
    super(message);
    this.name = 'BackendError';
  }
}

export interface RemoteTransportOptions {
  http: HttpClient;
  /** Override the minimum required backend version (tests). */
  minBackendVersion?: string;
  /**
   * Disk-backed catalog cache. When supplied, successful
   * getCapabilities() / listTools() responses are persisted and a
   * subsequent network failure reads from the cache instead of
   * throwing. Callers supplying a cache must also supply the API
   * URL via `apiUrl` so the cache can key off it.
   */
  cache?: CapabilitiesCache;
  /** The API URL the HTTP client is pointed at. Required iff `cache` is set. */
  apiUrl?: string;
  /**
   * Logger for cache fallback warnings. Called when the live fetch
   * fails but a cached copy is served instead. Caller is responsible
   * for routing this to stderr (stdio MCP servers never touch stdout).
   */
  log?: (msg: string) => void;
}

export class RemoteTransport implements Transport {
  private readonly http: HttpClient;
  private readonly minBackendVersion: string;
  private cachedCapabilities?: BackendCapabilities;
  private cachedTools?: McpTool[];
  private readonly cache?: CapabilitiesCache;
  private readonly apiUrl?: string;
  private readonly log: (msg: string) => void;

  constructor(opts: RemoteTransportOptions) {
    this.http = opts.http;
    this.minBackendVersion = opts.minBackendVersion ?? MIN_BACKEND_VERSION;
    if (opts.cache && !opts.apiUrl) {
      throw new Error(
        'RemoteTransport: `cache` option requires `apiUrl` so the cache can be keyed correctly.',
      );
    }
    this.cache = opts.cache;
    this.apiUrl = opts.apiUrl;
    this.log = opts.log ?? (() => undefined);
  }

  /** Translate outward-facing name → backend name (identity if unmapped). */
  private toBackendName(external: string): string {
    return TOOL_NAME_MAP[external] ?? external;
  }

  /** Translate backend name → outward-facing name (identity if unmapped). */
  private toExternalName(backend: string): string {
    return REVERSE_TOOL_NAME_MAP[backend] ?? backend;
  }

  async getCapabilities(): Promise<BackendCapabilities> {
    if (this.cachedCapabilities) {
      return this.cachedCapabilities;
    }

    let res;
    try {
      res = await this.http.request('GET', '/mcp/capabilities');
    } catch (err) {
      // Transport-level failure (DNS, TCP refused, TLS). Treat identically
      // to a non-2xx so the cache-fallback path applies to both.
      const fallback = this.fromCache('capabilities');
      if (fallback) return fallback;
      throw err;
    }
    if (!res.ok) {
      const fallback = this.fromCache('capabilities');
      if (fallback) return fallback;
      throw new BackendError(
        `GET /mcp/capabilities returned ${res.status} ${res.statusText}`,
      );
    }

    const body = (await res.json()) as BackendCapabilities;
    this.validateCapabilityShape(body);

    if (compareVersions(body.version, this.minBackendVersion) < 0) {
      // Version floors are a hard error — caching around them would let a
      // client silently talk to a too-old backend when the live refresh
      // fails. Throw without consulting the cache.
      throw new CapabilityMismatchError(body.version, this.minBackendVersion);
    }

    // Translate backend tool names → external MCP names so the rest of the
    // client only ever deals with the external surface. Backend names that
    // aren't in TOOL_NAME_MAP pass through unchanged.
    const mapped: BackendCapabilities = {
      version: body.version,
      features: body.features,
      tools: body.tools.map((name) => this.toExternalName(name)),
    };
    this.cachedCapabilities = mapped;
    this.persistToCache({ capabilities: mapped });
    return mapped;
  }

  async listTools(): Promise<McpTool[]> {
    if (this.cachedTools) {
      return this.cachedTools;
    }

    // Call the backend's MCP JSON-RPC tools/list, then filter + rename to the
    // tools we commit to exposing externally.
    let rpcRes;
    try {
      rpcRes = await this.rpc('tools/list');
    } catch (err) {
      const fallback = this.fromCache('tools');
      if (fallback) return fallback;
      throw err;
    }
    const raw = (rpcRes as { tools?: McpTool[] }).tools ?? [];

    const tools: McpTool[] = [];
    for (const tool of raw) {
      const external = this.toExternalName(tool.name);
      if (!EXPOSED_TOOLS.includes(external)) continue;
      tools.push({ ...tool, name: external });
    }

    // For any EXPOSED tool the backend didn't return, emit a stub so
    // capability-listed tools always appear in `tools/list`. This keeps the
    // MCP surface stable even if the backend hides a tool behind a flag.
    const seen = new Set(tools.map((t) => t.name));
    const caps = this.cachedCapabilities;
    if (caps) {
      for (const name of EXPOSED_TOOLS) {
        if (!seen.has(name) && caps.tools.includes(name)) {
          tools.push({
            name,
            description: `CodeRover tool: ${name}`,
            inputSchema: { type: 'object', properties: {}, required: [] },
          });
        }
      }
    }

    this.cachedTools = tools;
    this.persistToCache({ tools });
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    const backendName = this.toBackendName(name);
    const rpcRes = (await this.rpc('tools/call', {
      name: backendName,
      arguments: args,
    })) as McpToolResult;

    if (!rpcRes || !Array.isArray(rpcRes.content)) {
      throw new BackendError(
        `tools/call for "${name}" returned malformed response`,
      );
    }

    return rpcRes;
  }

  /** Low-level JSON-RPC call against POST /mcp. */
  private async rpc(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const res = await this.http.request('POST', '/mcp', {
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params: params ?? {},
    });
    if (!res.ok) {
      throw new BackendError(
        `POST /mcp (${method}) returned ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as {
      result?: unknown;
      error?: { code: number; message: string };
    };
    if (body.error) {
      throw new BackendError(
        `Backend RPC error ${body.error.code}: ${body.error.message}`,
      );
    }
    return body.result;
  }

  /**
   * Load a slice of the disk catalog on behalf of a live fetch that just
   * failed. Logs a one-line stderr warning the first time per process so
   * the user knows they're running against a cached catalog. Returns
   * `undefined` when no usable cache exists — the caller re-throws in
   * that case so the failure isn't swallowed.
   */
  private fromCache(
    slice: 'capabilities',
  ): BackendCapabilities | undefined;
  private fromCache(slice: 'tools'): McpTool[] | undefined;
  private fromCache(
    slice: 'capabilities' | 'tools',
  ): BackendCapabilities | McpTool[] | undefined {
    if (!this.cache || !this.apiUrl) return undefined;
    const entry = this.cache.read(this.apiUrl);
    if (!entry) return undefined;
    if (slice === 'capabilities') {
      const ageMin = Math.max(
        0,
        Math.floor((Date.now() - entry.fetchedAt) / 60_000),
      );
      this.log(
        `Backend unreachable; using cached capabilities from ${ageMin}m ago (v${entry.capabilities.version}).`,
      );
      this.cachedCapabilities = entry.capabilities;
      return entry.capabilities;
    }
    if (slice === 'tools') {
      const ageMin = Math.max(
        0,
        Math.floor((Date.now() - entry.fetchedAt) / 60_000),
      );
      this.log(
        `Backend unreachable; using cached tools/list (${entry.tools.length} tools, ${ageMin}m ago).`,
      );
      this.cachedTools = entry.tools;
      return entry.tools;
    }
    return undefined;
  }

  /** Best-effort persist to the disk cache. Write failures are silent. */
  private persistToCache(
    patch: { capabilities?: BackendCapabilities; tools?: McpTool[] },
  ): void {
    if (!this.cache || !this.apiUrl) return;
    try {
      this.cache.write(this.apiUrl, patch);
    } catch {
      // Already tolerated inside CapabilitiesCache.write — double-guard
      // here because persistence is never worth failing a live request.
    }
  }

  private validateCapabilityShape(body: unknown): asserts body is BackendCapabilities {
    const b = body as Partial<BackendCapabilities> | null;
    if (
      !b ||
      typeof b !== 'object' ||
      typeof b.version !== 'string' ||
      !Array.isArray(b.tools) ||
      !b.features ||
      typeof b.features.confidence_tags !== 'boolean' ||
      typeof b.features.incremental_cache !== 'boolean'
    ) {
      throw new BackendError(
        'GET /mcp/capabilities returned an unexpected shape. Backend may be too old.',
      );
    }
  }
}
