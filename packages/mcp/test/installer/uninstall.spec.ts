/**
 * runUninstall — agents get their coderover entry stripped, and ONLY their
 * coderover entry. Sibling servers + top-level keys survive.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { runUninstall } from '../../src/cli/uninstall';
import { ClaudeCodeAdapter } from '../../src/installer/agents/claude-code';
import { buildRemoteEntry } from '../../src/installer/agents/base';

async function mkHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'coderover-uninst-'));
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

describe('runUninstall', () => {
  it('errors on empty agent list', async () => {
    const s = streams();
    const res = await runUninstall(
      { agents: [], dryRun: false },
      { out: s.out, err: s.err },
    );
    expect(res.exitCode).toBe(1);
    expect(s.errText()).toMatch(/at least one/);
  });

  it('rejects unknown agent names', async () => {
    const s = streams();
    const res = await runUninstall(
      { agents: ['nope'], dryRun: false },
      { out: s.out, err: s.err },
    );
    expect(res.exitCode).toBe(1);
  });

  it('removes coderover entry from claude-code config', async () => {
    const home = await mkHome();
    const a = new ClaudeCodeAdapter(home);
    await a.writeMcpEntry(
      buildRemoteEntry({ apiUrl: 'https://x', token: 't' }),
    );
    const s = streams();
    const res = await runUninstall(
      { agents: ['claude-code'], dryRun: false },
      { out: s.out, err: s.err, homeDir: home },
    );
    expect(res.exitCode).toBe(0);
    expect(await a.hasMcpEntry()).toBe(false);
  });

  it('preserves non-coderover entries when uninstalling', async () => {
    const home = await mkHome();
    const a = new ClaudeCodeAdapter(home);
    await fs.mkdir(path.dirname(a.configPath), { recursive: true });
    await fs.writeFile(
      a.configPath,
      JSON.stringify({
        theme: 'dark',
        mcpServers: {
          coderover: { command: 'x', args: [], env: {} },
          linear: { command: 'l', args: [], env: {} },
        },
      }),
    );
    const s = streams();
    await runUninstall(
      { agents: ['claude-code'], dryRun: false },
      { out: s.out, err: s.err, homeDir: home },
    );
    const doc = JSON.parse(await fs.readFile(a.configPath, 'utf8'));
    expect(doc.theme).toBe('dark');
    expect(doc.mcpServers.linear).toBeDefined();
    expect(doc.mcpServers.coderover).toBeUndefined();
  });

  it('is a no-op when no coderover entry exists', async () => {
    const home = await mkHome();
    const a = new ClaudeCodeAdapter(home);
    await fs.mkdir(path.dirname(a.configPath), { recursive: true });
    await fs.writeFile(
      a.configPath,
      JSON.stringify({ theme: 'dark' }),
    );
    const s = streams();
    const res = await runUninstall(
      { agents: ['claude-code'], dryRun: false },
      { out: s.out, err: s.err, homeDir: home },
    );
    expect(res.exitCode).toBe(0);
    expect(s.outText()).toMatch(/nothing to remove/);
    // File unchanged.
    const doc = JSON.parse(await fs.readFile(a.configPath, 'utf8'));
    expect(doc.theme).toBe('dark');
  });

  it('dry-run prints without writing', async () => {
    const home = await mkHome();
    const a = new ClaudeCodeAdapter(home);
    await a.writeMcpEntry(
      buildRemoteEntry({ apiUrl: 'https://x', token: 't' }),
    );
    const before = await fs.readFile(a.configPath, 'utf8');
    const s = streams();
    await runUninstall(
      { agents: ['claude-code'], dryRun: true },
      { out: s.out, err: s.err, homeDir: home },
    );
    expect(s.outText()).toMatch(/dry-run/);
    expect(await fs.readFile(a.configPath, 'utf8')).toBe(before);
  });
});
