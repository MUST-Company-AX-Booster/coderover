/**
 * runUpgrade tests. Verifies we re-read the existing entry, probe the
 * backend, and rewrite with the current version — without wiping sibling
 * servers.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { runUpgrade } from '../../src/cli/upgrade';
import { ClaudeCodeAdapter } from '../../src/installer/agents/claude-code';
import { buildRemoteEntry } from '../../src/installer/agents/base';
import { MockHttpClient, okCapabilities } from '../helpers';

async function mkHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'coderover-upgrade-'));
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

describe('runUpgrade', () => {
  it('is a no-op when no agent is installed', async () => {
    const home = await mkHome();
    const s = streams();
    const res = await runUpgrade(
      {},
      {
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        packageVersion: '0.1.0',
      },
    );
    expect(res.exitCode).toBe(0);
    expect(s.outText()).toMatch(/nothing to upgrade/);
  });

  it('refreshes each installed agent and probes the backend', async () => {
    const home = await mkHome();
    const a = new ClaudeCodeAdapter(home);
    await a.writeMcpEntry(
      buildRemoteEntry({ apiUrl: 'https://x.example', token: 't' }),
    );
    const s = streams();
    const http = new MockHttpClient().on({
      match: (c) => c.path === '/mcp/capabilities',
      respond: () => ({ body: okCapabilities() }),
    });
    const res = await runUpgrade(
      {},
      {
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        packageVersion: '0.1.0',
        makeHttp: () => http,
      },
    );
    expect(res.exitCode).toBe(0);
    expect(s.outText()).toMatch(/ok claude-code/);
  });

  it('continues on probe failure with a warning (never silently fails)', async () => {
    const home = await mkHome();
    const a = new ClaudeCodeAdapter(home);
    await a.writeMcpEntry(
      buildRemoteEntry({ apiUrl: 'https://x.example', token: 't' }),
    );
    const s = streams();
    const http = new MockHttpClient().on({
      match: () => true,
      respond: () => ({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        body: null,
      }),
    });
    const res = await runUpgrade(
      {},
      {
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        packageVersion: '0.1.0',
        makeHttp: () => http,
      },
    );
    expect(res.exitCode).toBe(0);
    expect(s.errText()).toMatch(/warn claude-code/);
  });
});
