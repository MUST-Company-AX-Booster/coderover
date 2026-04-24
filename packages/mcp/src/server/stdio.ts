/**
 * Line-delimited JSON-RPC over stdio.
 *
 * MCP's stdio transport is: one JSON-RPC message per line on stdin, one
 * response per line on stdout. stderr is reserved for logs. This module is
 * a thin pump — parse stdin lines, hand them to an `McpServer`, write the
 * response. Everything hard lives in `McpServer.handle()`.
 */

import { createInterface, Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import {
  JsonRpcRequest,
  JsonRpcResponse,
  RpcErrorCode,
  rpcError,
} from '../protocol';
import type { McpServer } from './server';

export interface StdioRunnerOptions {
  server: McpServer;
  input?: Readable;
  output?: Writable;
  /** Logger for stderr messages. Default: console.error. */
  logError?: (msg: string) => void;
}

export class StdioRunner {
  private readonly server: McpServer;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly logError: (msg: string) => void;
  private rl?: Interface;

  constructor(opts: StdioRunnerOptions) {
    this.server = opts.server;
    this.input = opts.input ?? process.stdin;
    this.output = opts.output ?? process.stdout;
    this.logError = opts.logError ?? ((msg) => process.stderr.write(`${msg}\n`));
  }

  /**
   * Start the read loop. Resolves when the input stream closes.
   */
  async run(): Promise<void> {
    this.rl = createInterface({ input: this.input, crlfDelay: Infinity });

    for await (const raw of this.rl) {
      const line = raw.trim();
      if (!line) continue;
      await this.processLine(line);
    }
  }

  /** Exposed for tests — processes a single inbound JSON line. */
  async processLine(line: string): Promise<void> {
    let req: JsonRpcRequest | JsonRpcRequest[];
    try {
      req = JSON.parse(line);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeResponse(
        rpcError(null, RpcErrorCode.ParseError, `Parse error: ${msg}`),
      );
      return;
    }

    const batch = Array.isArray(req) ? req : [req];
    const responses: JsonRpcResponse[] = [];
    for (const r of batch) {
      const res = await this.server.handle(r);
      if (res !== null) responses.push(res);
    }

    // A batch request produces a batch response; a single request produces a
    // single response. Notifications (no id) produce no response at all.
    if (responses.length === 0) return;
    if (Array.isArray(req)) {
      this.writeResponse(responses);
    } else {
      this.writeResponse(responses[0]!);
    }
  }

  private writeResponse(res: JsonRpcResponse | JsonRpcResponse[]): void {
    try {
      this.output.write(`${JSON.stringify(res)}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logError(`Failed to write response: ${msg}`);
    }
  }

  close(): void {
    this.rl?.close();
  }
}
