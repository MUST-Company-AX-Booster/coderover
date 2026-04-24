/**
 * LocalTransport
 * ──────────────────────────────────────────────────────────────────────────────
 * Phase 11 Wave 1 (L3) — in-memory skeleton implementation of `Transport`.
 *
 * This is deliberately a stub. It returns hardcoded fixture payloads for the
 * three Phase 10 tools (`search_code`, `find_symbol`, `find_dependencies`) so
 * we can prove the MCP server ↔ transport plumbing works end-to-end without a
 * running backend. Waves 2 and 3 will replace the fixtures with real code
 * (SQLite-backed chunk/symbol/edge queries + tree-sitter extraction).
 *
 * Hard constraints for this file:
 *   - MUST NOT read or write files from disk.
 *   - MUST NOT require `better-sqlite3`, `sqlite-vec`, or any native module.
 *   - MUST implement the same `Transport` surface as `RemoteTransport` so
 *     `McpServer` is drop-in compatible.
 *
 * The fixture shapes mirror `packages/mcp-integration/src/scenarios/mcp-tools.spec.ts`
 * — that test is the canonical contract for what each tool returns.
 */

import {
  BackendCapabilities,
  McpTool,
  McpToolResult,
  RpcErrorCode,
} from '../protocol';
import type { Transport } from './transport';
import { computeNodeId } from '../local/deterministic-ids';
import type Database from 'better-sqlite3';
import type { Embedder } from '../local/embed/types';
import {
  searchCode,
  findSymbol,
  findDependencies,
} from '../local/query';
import { getPackageVersion } from '../version';

/**
 * Extended capability descriptor for local mode. Mirrors the remote
 * `/mcp/capabilities` shape but includes a few extra fields (local_mode,
 * minClientVersion) so downstream UIs can distinguish local from remote.
 *
 * This is intentionally a richer structure than the spare `BackendCapabilities`
 * that `Transport.getCapabilities()` returns — `capabilities()` is for
 * diagnostic / introspection use and is surfaced via the local CLI.
 */
export interface LocalCapabilities {
  protocolVersion: string;
  backendVersion: string;
  minClientVersion: string;
  tools: string[];
  features: {
    confidence_tags: boolean;
    streaming: boolean;
    local_mode: boolean;
  };
}

/**
 * Shape of a single tool's fixture payload. The `payload` is the object
 * that will be JSON-stringified into the MCP content block text.
 */
export interface ToolFixture {
  payload: unknown;
}

export interface Fixtures {
  search_code: ToolFixture;
  find_symbol: ToolFixture;
  find_dependencies: ToolFixture;
}

export interface LocalTransportOptions {
  /** Inject fixtures for testing. Defaults to the built-in set below. */
  fixtures?: Partial<Fixtures>;
  /** Override the reported backend version (diagnostics only). */
  backendVersion?: string;
  /**
   * Wave 3: when both `db` and `embedder` are provided, `callTool` routes
   * through the real SQLite-backed query modules instead of returning
   * fixture payloads. This is the production path; fixtures remain for
   * test ergonomics and pre-index bootstrap.
   */
  db?: Database.Database;
  embedder?: Embedder;
}

/**
 * Build the local backend version label lazily from the bundled
 * `package.json` so it tracks the published version automatically. We
 * still cache the resolved string per-instance so consumers see a stable
 * value across calls.
 */
function defaultLocalBackendVersion(): string {
  return `${getPackageVersion()}-local`;
}
const LOCAL_MIN_CLIENT_VERSION = '0.1.0';
const LOCAL_PROTOCOL_VERSION = '0.1.0';

/** Tools the local transport advertises. Matches the Phase 10 surface. */
export const LOCAL_EXPOSED_TOOLS = [
  'search_code',
  'find_symbol',
  'find_dependencies',
] as const;

/**
 * Canonical fixture pulled from mcp-tools.spec.ts line 128-151:
 *   computeNodeId('src/auth/auth.service.ts', 'class', 'AuthService')
 *
 * This anchor lets the integration layer assert deterministic-id parity
 * between local and remote mode.
 */
const FIXTURE_NODE_ID = computeNodeId(
  'src/auth/auth.service.ts',
  'class',
  'AuthService',
);

/**
 * Built-in fixture payloads. Wave 2+ will replace these with real query code
 * against the indexed SQLite database.
 */
export const DEFAULT_FIXTURES: Fixtures = {
  search_code: {
    payload: {
      query: '<fixture>',
      results: [
        {
          filePath: 'src/auth/auth.service.ts',
          lineStart: 1,
          lineEnd: 80,
          preview: '// src/auth/auth.service.ts',
          confidence: 'EXTRACTED',
          confidence_score: 1.0,
        },
      ],
    },
  },
  find_symbol: {
    payload: {
      symbolName: 'AuthService',
      results: [
        {
          filePath: 'src/auth/auth.service.ts',
          lineStart: 1,
          lineEnd: 80,
          node_id: FIXTURE_NODE_ID,
          confidence: 'EXTRACTED',
          confidence_score: 1.0,
        },
      ],
      totalFound: 1,
    },
  },
  find_dependencies: {
    payload: {
      target: 'src/auth/auth.service.ts',
      upstream: [
        {
          filePath: 'src/auth/auth.controller.ts',
          confidence: 'EXTRACTED',
          confidence_score: 1.0,
        },
      ],
      downstream: [
        {
          filePath: 'src/auth/jwt.strategy.ts',
          confidence: 'INFERRED',
          confidence_score: 0.6,
        },
      ],
    },
  },
};

/** Tool descriptors advertised via `tools/list`. */
const TOOL_DESCRIPTORS: McpTool[] = [
  {
    name: 'search_code',
    description:
      'Semantically search the local codebase for relevant code, services, or logic.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language or identifier query',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_symbol',
    description:
      'Find a symbol (class, function, interface) by name in the local codebase.',
    inputSchema: {
      type: 'object',
      properties: {
        symbolName: {
          type: 'string',
          description: 'The name of the symbol to locate',
        },
      },
      required: ['symbolName'],
    },
  },
  {
    name: 'find_dependencies',
    description:
      'Return upstream and downstream dependencies for a given file or symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'File path or symbol to analyze',
        },
      },
      required: ['target'],
    },
  },
];

/**
 * In-memory transport that mimics the remote MCP surface using hardcoded
 * fixtures. Wave 2+ replaces the fixture lookups with real DB queries.
 */
export class LocalTransport implements Transport {
  private readonly fixtures: Fixtures;
  private readonly backendVersion: string;
  private readonly db?: Database.Database;
  private readonly embedder?: Embedder;

  constructor(opts: LocalTransportOptions = {}) {
    // Merge partial user fixtures onto defaults so callers can override one
    // tool without having to re-specify the others.
    this.fixtures = {
      search_code: opts.fixtures?.search_code ?? DEFAULT_FIXTURES.search_code,
      find_symbol: opts.fixtures?.find_symbol ?? DEFAULT_FIXTURES.find_symbol,
      find_dependencies:
        opts.fixtures?.find_dependencies ?? DEFAULT_FIXTURES.find_dependencies,
    };
    this.backendVersion = opts.backendVersion ?? defaultLocalBackendVersion();
    this.db = opts.db;
    this.embedder = opts.embedder;
  }

  private get isLive(): boolean {
    return this.db !== undefined && this.embedder !== undefined;
  }

  /**
   * Minimal `BackendCapabilities` so `McpServer.handleInitialize` can build
   * its handshake envelope. The richer introspection shape lives in
   * `capabilities()` below.
   */
  async getCapabilities(): Promise<BackendCapabilities> {
    return {
      version: this.backendVersion,
      tools: [...LOCAL_EXPOSED_TOOLS],
      features: {
        confidence_tags: true,
        // Local mode has no incremental cache yet — that lands in Wave 3.
        incremental_cache: false,
      },
    };
  }

  /**
   * Extended capability descriptor for diagnostic / CLI introspection use.
   * Mirrors the shape the remote backend exposes at `GET /mcp/capabilities`
   * but adds `local_mode: true` so UIs can tell the two apart.
   */
  capabilities(): LocalCapabilities {
    return {
      protocolVersion: LOCAL_PROTOCOL_VERSION,
      backendVersion: this.backendVersion,
      minClientVersion: LOCAL_MIN_CLIENT_VERSION,
      tools: [...LOCAL_EXPOSED_TOOLS],
      features: {
        confidence_tags: true,
        streaming: false,
        local_mode: true,
      },
    };
  }

  async listTools(): Promise<McpTool[]> {
    // Return a defensive copy so callers can't mutate our descriptors.
    return TOOL_DESCRIPTORS.map((t) => ({
      ...t,
      inputSchema: {
        ...t.inputSchema,
        properties: { ...t.inputSchema.properties },
        required: t.inputSchema.required ? [...t.inputSchema.required] : [],
      },
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    if (!LOCAL_EXPOSED_TOOLS.includes(name as typeof LOCAL_EXPOSED_TOOLS[number])) {
      return {
        content: [{ type: 'text', text: `Tool "${name}" not found` }],
        isError: true,
      };
    }

    // Live path: route to real query modules when the DB + embedder are wired.
    if (this.isLive) {
      try {
        const payload = await this.callToolLive(name, args);
        return {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          isError: false,
        };
      } catch (err) {
        // Argument-shape failures get a clean prefix so agents can
        // distinguish them from internal errors and retry with corrected
        // input. Other errors keep the existing `Error:` envelope.
        if (err instanceof InvalidArgumentError) {
          return {
            content: [{ type: 'text', text: `InvalidArgument: ${err.message}` }],
            isError: true,
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Error: ${msg}` }],
          isError: true,
        };
      }
    }

    // Fixture path: reflect the caller's primary argument into the payload so
    // consumers see `{ query } / { symbolName } / { target }` round-trip.
    const fixture = this.fixtures[name as keyof Fixtures];
    const payload = this.reflectArgs(name, args, fixture.payload);
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: false,
    };
  }

  private async callToolLive(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const db = this.db!;
    if (name === 'search_code') {
      const query = typeof args.query === 'string' ? args.query : '';
      // Empty / missing query previously fell through to KNN over the
      // entire `code_chunks_vec` table and returned arbitrary rows with
      // a confidence the agent had no way to discount. Reject loudly.
      if (!query.trim()) {
        throw new InvalidArgumentError(
          'search_code: "query" is required and must be a non-empty string',
        );
      }
      const payload = await searchCode(query, {
        db,
        embedder: this.embedder!,
      });
      return this.attachMeta(payload);
    }
    if (name === 'find_symbol') {
      const symbolName =
        typeof args.symbolName === 'string' ? args.symbolName : '';
      // Empty / missing symbolName used to expand `LIKE '' || '%'` into a
      // match-everything clause, so the response was the entire `symbols`
      // table stamped at confidence 1.0. Reject the call instead.
      if (!symbolName.trim()) {
        throw new InvalidArgumentError(
          'find_symbol: "symbolName" is required and must be a non-empty string',
        );
      }
      return findSymbol(symbolName, { db });
    }
    if (name === 'find_dependencies') {
      const target = typeof args.target === 'string' ? args.target : '';
      if (!target.trim()) {
        throw new InvalidArgumentError(
          'find_dependencies: "target" is required and must be a non-empty string',
        );
      }
      return findDependencies(target, { db });
    }
    throw new Error(`unreachable: unknown tool ${name}`);
  }

  /**
   * Add a `meta` block to a tool payload so callers can tell which
   * embedder produced the scores. Today we surface the embedder mode for
   * `search_code` (the only tool whose ranking depends on it); other
   * tools pass through unchanged. Mock-mode results in particular have
   * no semantic signal — flagging that here is what stops downstream
   * agents from treating those scores as real ranking.
   */
  private attachMeta(payload: unknown): unknown {
    if (!payload || typeof payload !== 'object') return payload;
    const mode = this.embedder?.modeLabel;
    if (!mode) return payload;
    return { ...(payload as Record<string, unknown>), meta: { embedder: mode } };
  }

  /**
   * Overlay the user-supplied primary argument onto the fixture payload so
   * the echoed shape matches what the remote backend would return. We only
   * touch the single "anchor" field per tool; everything else is passthrough.
   */
  private reflectArgs(
    name: string,
    args: Record<string, unknown>,
    payload: unknown,
  ): unknown {
    if (!payload || typeof payload !== 'object') return payload;
    const obj = payload as Record<string, unknown>;
    if (name === 'search_code' && typeof args.query === 'string') {
      return { ...obj, query: args.query };
    }
    if (name === 'find_symbol' && typeof args.symbolName === 'string') {
      return { ...obj, symbolName: args.symbolName };
    }
    if (name === 'find_dependencies' && typeof args.target === 'string') {
      return { ...obj, target: args.target };
    }
    return payload;
  }
}

/** Exposed so callers outside this file can reach the same error code. */
export const LOCAL_METHOD_NOT_FOUND = RpcErrorCode.MethodNotFound;

/**
 * Thrown by {@link LocalTransport.callToolLive} when a tool's required
 * argument is missing or empty. Caught at the `callTool` boundary and
 * surfaced as `isError: true` with an `InvalidArgument:` prefix so an
 * agent can tell shape failures apart from runtime errors.
 *
 * Internal — kept un-exported so the only call path is via the transport.
 */
class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArgumentError';
  }
}
