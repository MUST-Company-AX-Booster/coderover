/**
 * Transport abstraction.
 *
 * The MCP server talks to "something" to actually answer tool calls. In A2
 * (this PR) the only implementation is `RemoteTransport`, which speaks HTTPS
 * to a running CodeRover API. A3 will add `LocalTransport` that embeds
 * tree-sitter + sqlite-vec and answers locally. Both will implement this
 * interface so the stdio server layer stays transport-agnostic.
 */

import type { BackendCapabilities, McpTool, McpToolResult } from '../protocol';

export interface Transport {
  /**
   * Fetch backend capabilities. Called during MCP `initialize` so we can
   * surface a clear error if the backend is too old, and so the tool list
   * we advertise matches what the backend can actually execute.
   */
  getCapabilities(): Promise<BackendCapabilities>;

  /**
   * Return the full tool catalog in MCP wire format.
   * Mapped from backend parameter schemas to MCP inputSchema.
   */
  listTools(): Promise<McpTool[]>;

  /**
   * Execute a single tool by name. The transport MUST NOT throw on
   * tool-level failures — it returns `{ isError: true }` instead. It MAY
   * throw for network / auth / protocol failures (those surface as
   * JSON-RPC errors to the MCP host).
   */
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}
