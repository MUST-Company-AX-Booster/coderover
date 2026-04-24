/**
 * MCP Protocol Controller
 *
 * Implements the Model Context Protocol (MCP) spec so that IDEs like
 * Trae, Cursor, and Continue can connect directly via:
 *   - Streamable HTTP  →  POST /mcp   (single-request/response)
 *   - SSE transport    →  GET /mcp    (persistent event stream)
 *                         POST /mcp/message  (client sends messages)
 *
 * JSON-RPC 2.0 methods supported:
 *   initialize          → server info + capabilities
 *   tools/list          → list of available MCP tools
 *   tools/call          → execute a tool by name
 *   ping                → health check
 *
 * Auth: Bearer JWT (same as the rest of the API).
 * The JWT guard is applied per-handler so that SSE clients can subscribe
 * after authenticating with the initial request.
 */
import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Res,
  Logger,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { McpService } from './mcp.service';

// ─── JSON-RPC Types ────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, any>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

// ─── MCP Server Info ───────────────────────────────────────────────────────────

const MCP_SERVER_INFO = {
  name: 'coderover',
  version: '3.0.0',
  vendor: 'Independent',
};

const MCP_CAPABILITIES = {
  tools: { listChanged: false },
};

// ─── Controller ────────────────────────────────────────────────────────────────

@Controller('mcp')
@ApiTags('mcp-protocol')
@ApiBearerAuth()
export class McpProtocolController {
  private readonly logger = new Logger(McpProtocolController.name);

  /** Active SSE clients: sessionId → Response object */
  private readonly sseClients = new Map<string, Response>();

  constructor(private readonly mcpService: McpService) {}

  // ──────────────────────────────────────────────────────────────────────────────
  // Streamable HTTP transport: POST /mcp
  // Trae/Cursor first tries this. One request → one JSON-RPC response.
  // No persistent connection needed.
  // ──────────────────────────────────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Handle MCP JSON-RPC over streamable HTTP transport' })
  @ApiBody({
    description: 'Single JSON-RPC request or JSON-RPC batch array',
    schema: {
      oneOf: [
        {
          type: 'object',
          example: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {},
          },
        },
        {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              jsonrpc: { type: 'string', example: '2.0' },
              id: { oneOf: [{ type: 'string' }, { type: 'number' }] },
              method: { type: 'string', example: 'ping' },
              params: { type: 'object' },
            },
          },
          example: [
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'Trae' } } },
            { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
          ],
        },
      ],
    },
  })
  @ApiOkResponse({
    description: 'JSON-RPC response object or array',
    schema: {
      example: {
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: [],
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async handleStreamable(
    @Body() body: JsonRpcRequest | JsonRpcRequest[],
    @Res() res: Response,
  ): Promise<void> {
    this.logger.debug(`Streamable HTTP: ${JSON.stringify(body)}`);

    // Support both single request and batch
    const requests = Array.isArray(body) ? body : [body];
    const responses: JsonRpcResponse[] = [];

    for (const req of requests) {
      const rpc = await this.handleRpc(req);
      if (rpc !== null) {
        // null = notification (no id), no response needed
        responses.push(rpc);
      }
    }

    // Return single object or array to match request shape
    const payload = Array.isArray(body) ? responses : responses[0] ?? {};
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(payload));
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // SSE transport: GET /mcp
  // Trae falls back to this if Streamable HTTP returns 404 or fails.
  // Client subscribes once; server pushes events. Client then posts to
  // POST /mcp/message to send JSON-RPC requests.
  // ──────────────────────────────────────────────────────────────────────────────

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Open MCP SSE transport channel' })
  @ApiOkResponse({
    description: 'SSE stream emits endpoint and subsequent RPC result events',
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
          example: 'event: endpoint\ndata: {"endpoint":"/mcp/message?sessionId=sse-..."}\n\n',
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async openSse(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sessionId = `sse-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    this.logger.log(`SSE client connected: ${sessionId}`);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    res.flushHeaders();

    // Register client
    this.sseClients.set(sessionId, res);

    // Send the endpoint URL so the client knows where to POST messages
    const endpoint = `/mcp/message?sessionId=${sessionId}`;
    this.sendSseEvent(res, 'endpoint', JSON.stringify({ endpoint }));

    // Keepalive ping every 15s
    const keepalive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': ping\n\n');
      } else {
        clearInterval(keepalive);
      }
    }, 15_000);

    // Cleanup on disconnect
    req.on('close', () => {
      this.logger.log(`SSE client disconnected: ${sessionId}`);
      clearInterval(keepalive);
      this.sseClients.delete(sessionId);
    });
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // SSE message endpoint: POST /mcp/message?sessionId=xxx
  // Client sends JSON-RPC here; response is pushed back over the SSE stream.
  // ──────────────────────────────────────────────────────────────────────────────

  @Post('message')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Send JSON-RPC request(s) tied to an open MCP SSE session' })
  @ApiQuery({
    name: 'sessionId',
    required: true,
    description: 'Session ID from the SSE endpoint event',
    example: 'sse-1710000000000-abc123',
  })
  @ApiBody({
    description: 'Single JSON-RPC request or batch array',
    schema: {
      oneOf: [
        {
          type: 'object',
          example: {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'search_codebase', arguments: { query: 'auth guard' } },
          },
        },
        {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              jsonrpc: { type: 'string', example: '2.0' },
              id: { oneOf: [{ type: 'string' }, { type: 'number' }] },
              method: { type: 'string', example: 'ping' },
              params: { type: 'object' },
            },
          },
        },
      ],
    },
  })
  @ApiAcceptedResponse({
    description: 'Accepted. Actual JSON-RPC responses are delivered via SSE event stream.',
    schema: {
      example: {},
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async handleSseMessage(
    @Body() body: JsonRpcRequest | JsonRpcRequest[],
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const sessionId = (req.query.sessionId as string) ?? '';
    const sseRes = this.sseClients.get(sessionId);

    this.logger.debug(`SSE message (session=${sessionId}): ${JSON.stringify(body)}`);

    const requests = Array.isArray(body) ? body : [body];

    for (const rpcReq of requests) {
      const rpcRes = await this.handleRpc(rpcReq);
      if (rpcRes !== null && sseRes && !sseRes.writableEnded) {
        this.sendSseEvent(sseRes, 'message', JSON.stringify(rpcRes));
      }
    }

    // HTTP 202 Accepted — actual response was pushed via SSE
    res.end();
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Core JSON-RPC dispatcher
  // ──────────────────────────────────────────────────────────────────────────────

  private async handleRpc(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    // Notifications (id=undefined/null with no response expected)
    if (req.id === undefined) {
      return null;
    }

    try {
      switch (req.method) {
        case 'initialize':
          return this.rpcOk(req.id, this.handleInitialize(req.params));

        case 'notifications/initialized':
          // Client ack — no response needed
          return null;

        case 'ping':
          return this.rpcOk(req.id, {});

        case 'tools/list':
          return this.rpcOk(req.id, await this.handleToolsList());

        case 'tools/call':
          return this.rpcOk(req.id, await this.handleToolsCall(req.params));

        default:
          this.logger.warn(`Unknown MCP method: ${req.method}`);
          return this.rpcError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`RPC error for ${req.method}: ${msg}`);
      return this.rpcError(req.id, -32603, msg);
    }
  }

  // ─── Method Handlers ──────────────────────────────────────────────────────────

  private handleInitialize(params?: Record<string, any>): any {
    this.logger.log(`MCP initialize from: ${params?.clientInfo?.name ?? 'unknown client'}`);
    return {
      protocolVersion: '2024-11-05',
      serverInfo: MCP_SERVER_INFO,
      capabilities: MCP_CAPABILITIES,
    };
  }

  private async handleToolsList(): Promise<any> {
    const tools = this.mcpService.getTools();

    return {
      tools: tools.map((tool) => {
        const properties: Record<string, any> = {};
        const required: string[] = [];

        for (const param of tool.parameters) {
          properties[param.name] = {
            type: param.type,
            description: param.description,
          };
          if (param.enum) {
            properties[param.name].enum = param.enum;
          }
          if (param.required) {
            required.push(param.name);
          }
        }

        return {
          name: tool.name,
          description: tool.description,
          inputSchema: {
            type: 'object',
            properties,
            required,
          },
        };
      }),
    };
  }

  private async handleToolsCall(params?: Record<string, any>): Promise<any> {
    const toolName = params?.name as string;
    const args = (params?.arguments ?? {}) as Record<string, any>;

    if (!toolName) {
      throw new Error('tools/call requires params.name');
    }

    this.logger.log(`tools/call: ${toolName}(${JSON.stringify(args)})`);

    const call = await this.mcpService.executeTool(toolName, args);

    if (call.error) {
      // MCP spec: return isError=true in content, not a JSON-RPC error
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${call.error}`,
          },
        ],
        isError: true,
      };
    }

    // Serialize result as MCP text content
    const resultText =
      typeof call.result === 'string'
        ? call.result
        : JSON.stringify(call.result, null, 2);

    return {
      content: [
        {
          type: 'text',
          text: resultText,
        },
      ],
      isError: false,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private rpcOk(id: string | number | null, result: any): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private rpcError(
    id: string | number | null,
    code: number,
    message: string,
    data?: any,
  ): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message, data } };
  }

  private sendSseEvent(res: Response, event: string, data: string): void {
    res.write(`event: ${event}\ndata: ${data}\n\n`);
  }
}
