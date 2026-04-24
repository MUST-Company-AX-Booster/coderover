/**
 * Small sanity tests for the pure helpers in protocol.ts. These are cheap,
 * isolated, and catch dumb semver-comparison bugs before the integration
 * tests ever run.
 */

import { compareVersions, rpcOk, rpcError } from '../src/protocol';

describe('compareVersions', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.0', '1.0.1', -1],
    ['1.0.1', '1.0.0', 1],
    ['0.9.1', '0.10.0', -1],
    ['0.10.0', '0.9.1', 1],
    ['1', '1.0.0', 0],
    ['2.0', '1.99.99', 1],
  ])('compareVersions(%s, %s) = %d', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});

describe('rpc helpers', () => {
  it('rpcOk wraps with jsonrpc 2.0', () => {
    expect(rpcOk(1, { hi: true })).toEqual({ jsonrpc: '2.0', id: 1, result: { hi: true } });
  });
  it('rpcError includes code/message/data', () => {
    const e = rpcError(1, -32000, 'bad', { extra: 1 });
    expect(e).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'bad', data: { extra: 1 } } });
  });
});
