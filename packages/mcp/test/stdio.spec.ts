/**
 * StdioRunner — line-delimited JSON-RPC pump.
 *
 * We test the pure `processLine()` path (not the readline loop) because
 * that's where the protocol logic lives. Input malformed JSON → parse error;
 * valid request → one line of response; batch → one line containing an array.
 */

import { Writable } from 'node:stream';
import { McpServer } from '../src/server/server';
import { RemoteTransport } from '../src/transport/remote-transport';
import { StdioRunner } from '../src/server/stdio';
import { MockHttpClient, okCapabilities } from './helpers';

function collectingSink(): { sink: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  return {
    sink,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.length > 0),
  };
}

describe('StdioRunner', () => {
  function makeRunner() {
    const http = new MockHttpClient().on({
      match: (c) => c.path === '/mcp/capabilities',
      respond: () => ({ body: okCapabilities() }),
    });
    const server = new McpServer({ transport: new RemoteTransport({ http }) });
    const { sink, lines } = collectingSink();
    const runner = new StdioRunner({ server, output: sink });
    return { runner, lines };
  }

  it('writes one response line for one request line', async () => {
    const { runner, lines } = makeRunner();
    await runner.processLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    expect(lines()).toHaveLength(1);
    const parsed = JSON.parse(lines()[0]!);
    expect(parsed.id).toBe(1);
    expect(parsed.result).toEqual({});
  });

  it('writes no response for a notification', async () => {
    const { runner, lines } = makeRunner();
    await runner.processLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    expect(lines()).toHaveLength(0);
  });

  it('emits a parse-error response when the line is not valid JSON', async () => {
    const { runner, lines } = makeRunner();
    await runner.processLine('not-json{{{');
    const parsed = JSON.parse(lines()[0]!);
    expect(parsed.error.code).toBe(-32700);
    expect(parsed.id).toBeNull();
  });

  it('handles a JSON-RPC batch', async () => {
    const { runner, lines } = makeRunner();
    await runner.processLine(
      JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', id: 2, method: 'ping' },
      ]),
    );
    const parsed = JSON.parse(lines()[0]!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
  });
});
