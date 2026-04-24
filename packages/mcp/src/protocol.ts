/**
 * JSON-RPC 2.0 types used by the Model Context Protocol.
 *
 * MCP is a thin JSON-RPC 2.0 layer over a bidirectional stream (stdio in our
 * case). This module deliberately re-declares the small subset we need instead
 * of pulling in `@modelcontextprotocol/sdk` — keeps the bundle tiny and gives
 * us a single source of truth shared with the Nest backend's JSON-RPC
 * dispatcher. If/when we adopt the SDK, this file is the only replacement
 * point.
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** Protocol version we implement against. Matches backend. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** Minimum backend version this client is known to work against. */
export const MIN_BACKEND_VERSION = '0.9.0';

/** What we advertise to the MCP host during `initialize`. */
export interface ServerInfo {
  name: string;
  version: string;
}

export interface ServerCapabilities {
  tools: { listChanged: boolean };
}

/** Shape returned by GET /mcp/capabilities on the backend. */
export interface BackendCapabilities {
  version: string;
  tools: string[];
  features: {
    confidence_tags: boolean;
    incremental_cache: boolean;
  };
}

/** Shape of a tool as it appears in `tools/list` responses. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Shape of a tool result (MCP content blocks). */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
}

/** Standard JSON-RPC error codes + MCP-specific. */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** CodeRover-specific: backend version too old for this client. */
  CapabilityMismatch: -32000,
  /** CodeRover-specific: backend unreachable. */
  BackendUnreachable: -32001,
} as const;

export function rpcOk(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

/**
 * Compare two semver-ish strings ("0.9.1" vs "0.10.0"). Returns -1/0/1.
 * We only compare MAJOR.MINOR.PATCH, ignoring pre-release tags.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((p) => parseInt(p, 10) || 0);
  const pb = b.split('.').map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}
