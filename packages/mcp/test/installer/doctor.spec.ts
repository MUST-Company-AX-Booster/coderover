/**
 * runDoctor tests.
 *
 * Uses MockHttpClient from `../helpers.ts` (scripted per-URL responses), so
 * we can simulate: green, revoked token, version mismatch, unreachable.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { runDoctor, probeBackend } from '../../src/cli/doctor';
import { ClaudeCodeAdapter } from '../../src/installer/agents/claude-code';
import { buildRemoteEntry } from '../../src/installer/agents/base';
import { MockHttpClient, okCapabilities } from '../helpers';
import type { HttpClient, HttpResponse } from '../../src/transport/http-client';

async function mkHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'coderover-doctor-'));
}

function streams() {
  const out = new PassThrough();
  const err = new PassThrough();
  const outBuf: string[] = [];
  const errBuf: string[] = [];
  out.on('data', (c) => outBuf.push(c.toString()));
  err.on('data', (c) => errBuf.push(c.toString()));
  return {
    out,
    err,
    outText: () => outBuf.join(''),
    errText: () => errBuf.join(''),
  };
}

describe('runDoctor', () => {
  it('prints node + package version and "not installed" for each agent when nothing is set up', async () => {
    const home = await mkHome();
    const s = streams();
    const res = await runDoctor(
      {},
      {
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        nodeVersion: '20.0.0',
        packageVersion: '0.1.0',
      },
    );
    expect(res.exitCode).toBe(0);
    expect(s.outText()).toMatch(/node 20.0.0/);
    expect(s.outText()).toMatch(/@coderover\/mcp 0\.1\.0/);
    expect(s.outText()).toMatch(/claude-code: not installed/);
  });

  it('reports GREEN when backend returns fresh capabilities', async () => {
    const home = await mkHome();
    const a = new ClaudeCodeAdapter(home);
    await a.writeMcpEntry(
      buildRemoteEntry({ apiUrl: 'https://x.example', token: 't' }),
    );
    const s = streams();
    const http = new MockHttpClient().on({
      match: (c) => c.path === '/mcp/capabilities',
      respond: () => ({ body: okCapabilities({ version: '0.10.0' }) }),
    });
    const res = await runDoctor(
      {},
      {
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        nodeVersion: '20.0.0',
        packageVersion: '0.1.0',
        makeHttp: () => http,
      },
    );
    expect(res.exitCode).toBe(0);
    expect(s.outText()).toMatch(/ok claude-code/);
  });

  it('flags revoked token (401) with an actionable hint', async () => {
    const home = await mkHome();
    const a = new ClaudeCodeAdapter(home);
    await a.writeMcpEntry(
      buildRemoteEntry({ apiUrl: 'https://x.example', token: 't' }),
    );
    const s = streams();
    const http = new MockHttpClient().on({
      match: (c) => c.path === '/mcp/capabilities',
      respond: () => ({ ok: false, status: 401, statusText: 'Unauthorized', body: null }),
    });
    const res = await runDoctor(
      {},
      {
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        nodeVersion: '20.0.0',
        packageVersion: '0.1.0',
        makeHttp: () => http,
      },
    );
    expect(res.exitCode).toBe(1);
    expect(s.errText()).toMatch(/auth failed/);
    expect(s.errText()).toMatch(/revoked/);
  });

  it('flags version mismatch when backend is older than MIN_BACKEND_VERSION', async () => {
    const home = await mkHome();
    const a = new ClaudeCodeAdapter(home);
    await a.writeMcpEntry(
      buildRemoteEntry({ apiUrl: 'https://x.example', token: 't' }),
    );
    const s = streams();
    const http = new MockHttpClient().on({
      match: (c) => c.path === '/mcp/capabilities',
      respond: () => ({ body: okCapabilities({ version: '0.5.0' }) }),
    });
    const res = await runDoctor(
      {},
      {
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        nodeVersion: '20.0.0',
        packageVersion: '0.1.0',
        makeHttp: () => http,
      },
    );
    expect(res.exitCode).toBe(1);
    expect(s.errText()).toMatch(/0\.5\.0/);
    expect(s.errText()).toMatch(/upgrade/);
  });

  it('reports unreachable backend with a network hint', async () => {
    const home = await mkHome();
    const a = new ClaudeCodeAdapter(home);
    await a.writeMcpEntry(
      buildRemoteEntry({ apiUrl: 'https://x.example', token: 't' }),
    );
    const s = streams();
    const http: HttpClient = {
      async request(
        _method: 'GET' | 'POST',
        _path: string,
      ): Promise<HttpResponse> {
        throw new Error('ECONNREFUSED');
      },
    };
    const res = await runDoctor(
      {},
      {
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        nodeVersion: '20.0.0',
        packageVersion: '0.1.0',
        makeHttp: () => http,
      },
    );
    expect(res.exitCode).toBe(1);
    expect(s.errText()).toMatch(/ECONNREFUSED/);
    expect(s.errText()).toMatch(/VPN|firewall|URL/);
  });

  it('rejects unknown agent filter', async () => {
    const home = await mkHome();
    const s = streams();
    const res = await runDoctor(
      { agent: 'nope' },
      {
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        nodeVersion: '20.0.0',
        packageVersion: '0.1.0',
      },
    );
    expect(res.exitCode).toBe(1);
    expect(s.errText()).toMatch(/unknown agent/);
  });
});

describe('probeBackend', () => {
  it('returns ok with latency when backend responds healthy', async () => {
    const http = new MockHttpClient().on({
      match: () => true,
      respond: () => ({ body: okCapabilities() }),
    });
    const r = await probeBackend(http);
    expect(r.ok).toBe(true);
    expect(typeof r.latencyMs).toBe('number');
  });

  it('returns reason "capabilities body was not JSON" on malformed JSON', async () => {
    const http: HttpClient = {
      async request(
        _method: 'GET' | 'POST',
        _path: string,
      ): Promise<HttpResponse> {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => 'not json',
          json: async () => {
            throw new Error('parse fail');
          },
        };
      },
    };
    const r = await probeBackend(http);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/was not JSON/);
  });
});
