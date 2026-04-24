/**
 * McpServer
 * ──────────────────────────────────────────────────────────────────────────────
 * Dispatches MCP JSON-RPC 2.0 methods to a `Transport`. Transport-agnostic:
 * `RemoteTransport` today, `LocalTransport` in A3.
 *
 * Methods handled:
 *   - initialize                (handshake + capability check)
 *   - notifications/initialized (ack, no response)
 *   - ping                      (liveness)
 *   - tools/list
 *   - tools/call
 *
 * Any other method returns JSON-RPC -32601 (Method not found).
 */

import {
  JsonRpcRequest,
  JsonRpcResponse,
  MCP_PROTOCOL_VERSION,
  RpcErrorCode,
  ServerCapabilities,
  ServerInfo,
  rpcError,
  rpcOk,
} from '../protocol';
import type { Transport } from '../transport/transport';
import {
  CapabilityMismatchError,
  BackendError,
} from '../transport/remote-transport';
import { getPackageVersion } from '../version';

export interface McpServerOptions {
  transport: Transport;
  serverInfo?: ServerInfo;
  /** Optional logger hook — defaults to silent (stdio is reserved for RPC). */
  log?: (msg: string) => void;
}

function defaultServerInfo(): ServerInfo {
  return {
    name: 'coderover-mcp',
    version: getPackageVersion(),
  };
}

const SERVER_CAPABILITIES: ServerCapabilities = {
  tools: { listChanged: false },
};

export class McpServer {
  private readonly transport: Transport;
  private readonly serverInfo: ServerInfo;
  private readonly log: (msg: string) => void;
  private initialized = false;

  constructor(opts: McpServerOptions) {
    this.transport = opts.transport;
    this.serverInfo = opts.serverInfo ?? defaultServerInfo();
    this.log = opts.log ?? (() => undefined);
  }

  /** Has the MCP host sent `notifications/initialized`? */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Handle a single JSON-RPC request. Returns `null` for notifications
   * (no `id`) — the caller should not write a response in that case.
   *
   * JSON-RPC 2.0 distinguishes notifications (no `id` property) from
   * null-id requests (which still expect a response). MCP hosts in the
   * wild use both shapes, so we treat the `notifications/*` namespace as
   * notification by method name in addition to the missing-id check.
   */
  async handle(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const isNotification =
      req.id === undefined || req.method.startsWith('notifications/');
    if (isNotification) {
      if (req.method === 'notifications/initialized') {
        this.initialized = true;
      }
      return null;
    }

    // After the notification guard, `req.id` is guaranteed defined.
    const id = req.id as Exclude<typeof req.id, undefined>;

    try {
      switch (req.method) {
        case 'initialize':
          return rpcOk(id, await this.handleInitialize());

        case 'ping':
          return rpcOk(id, {});

        case 'tools/list':
          return rpcOk(id, { tools: await this.transport.listTools() });

        case 'tools/call':
          return rpcOk(id, await this.handleToolsCall(req.params));

        default:
          return rpcError(
            id,
            RpcErrorCode.MethodNotFound,
            `Method not found: ${req.method}`,
          );
      }
    } catch (err) {
      return this.errToRpc(id, err);
    }
  }

  private async handleInitialize(): Promise<{
    protocolVersion: string;
    serverInfo: ServerInfo;
    capabilities: ServerCapabilities;
    backend: { version: string; features: Record<string, boolean> };
  }> {
    // Fetching capabilities here is where we enforce the version handshake.
    // If the backend is too old, `getCapabilities()` throws
    // `CapabilityMismatchError` and the MCP host sees a clean JSON-RPC error.
    const caps = await this.transport.getCapabilities();
    this.log(`Connected to backend v${caps.version}`);

    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: this.serverInfo,
      capabilities: SERVER_CAPABILITIES,
      backend: {
        version: caps.version,
        features: {
          confidence_tags: caps.features.confidence_tags,
          incremental_cache: caps.features.incremental_cache,
        },
      },
    };
  }

  private async handleToolsCall(params?: Record<string, unknown>): Promise<unknown> {
    const name = typeof params?.name === 'string' ? params.name : '';
    const args =
      params?.arguments && typeof params.arguments === 'object'
        ? (params.arguments as Record<string, unknown>)
        : {};

    if (!name) {
      return {
        content: [{ type: 'text', text: 'Error: tools/call requires params.name' }],
        isError: true,
      };
    }

    return await this.transport.callTool(name, args);
  }

  private errToRpc(id: JsonRpcRequest['id'], err: unknown): JsonRpcResponse {
    const safeId = id === undefined ? null : id;
    if (err instanceof CapabilityMismatchError) {
      return rpcError(safeId, err.code, err.message, {
        backendVersion: err.backendVersion,
        minRequired: err.minRequired,
      });
    }
    if (err instanceof BackendError) {
      return rpcError(safeId, err.code, err.message);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return rpcError(safeId, RpcErrorCode.InternalError, msg);
  }
}
