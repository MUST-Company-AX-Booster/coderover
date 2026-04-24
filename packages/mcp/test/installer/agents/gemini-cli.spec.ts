/**
 * GeminiCliAdapter tests.
 *
 * Gemini uses an ARRAY under `mcp.servers[]` keyed by `name`. We merge by
 * name, preserving ordering of other entries.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GeminiCliAdapter } from '../../../src/installer/agents/gemini-cli';
import { buildRemoteEntry } from '../../../src/installer/agents/base';

async function mkHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'coderover-gemini-'));
}

const entry = buildRemoteEntry({
  apiUrl: 'https://api.example.com',
  token: 'tok_gem',
});

describe('GeminiCliAdapter', () => {
  it('resolves to ~/.gemini/settings.json', async () => {
    const home = await mkHome();
    const a = new GeminiCliAdapter(home);
    expect(a.configPath).toBe(path.join(home, '.gemini', 'settings.json'));
  });

  it('writes fresh config', async () => {
    const home = await mkHome();
    const a = new GeminiCliAdapter(home);
    await a.writeMcpEntry(entry);
    const doc = JSON.parse(await fs.readFile(a.configPath, 'utf8'));
    expect(Array.isArray(doc.mcp.servers)).toBe(true);
    expect(doc.mcp.servers[0].name).toBe('coderover');
    expect(doc.mcp.servers[0].env.CODEROVER_API_URL).toBe(
      'https://api.example.com',
    );
  });

  it('preserves other servers in mcp.servers[]', async () => {
    const home = await mkHome();
    const a = new GeminiCliAdapter(home);
    await fs.mkdir(path.dirname(a.configPath), { recursive: true });
    await fs.writeFile(
      a.configPath,
      JSON.stringify({
        theme: 'dark',
        mcp: {
          servers: [
            { name: 'linear', command: 'linear-mcp', args: [], env: {} },
          ],
        },
      }),
    );
    await a.writeMcpEntry(entry);
    const doc = JSON.parse(await fs.readFile(a.configPath, 'utf8'));
    expect(doc.theme).toBe('dark');
    const names = doc.mcp.servers.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual(['coderover', 'linear']);
  });

  it('replaces existing coderover entry (by name) rather than duplicating', async () => {
    const home = await mkHome();
    const a = new GeminiCliAdapter(home);
    await fs.mkdir(path.dirname(a.configPath), { recursive: true });
    await fs.writeFile(
      a.configPath,
      JSON.stringify({
        mcp: {
          servers: [
            { name: 'coderover', command: 'OLD', args: [], env: {} },
            { name: 'other', command: 'other', args: [], env: {} },
          ],
        },
      }),
    );
    await a.writeMcpEntry(entry);
    const doc = JSON.parse(await fs.readFile(a.configPath, 'utf8'));
    const coderovers = doc.mcp.servers.filter(
      (s: { name: string }) => s.name === 'coderover',
    );
    expect(coderovers.length).toBe(1);
    expect(coderovers[0].command).toBe('npx');
    expect(
      doc.mcp.servers.some((s: { name: string }) => s.name === 'other'),
    ).toBe(true);
  });

  it('removeMcpEntry deletes only the coderover entry', async () => {
    const home = await mkHome();
    const a = new GeminiCliAdapter(home);
    await fs.mkdir(path.dirname(a.configPath), { recursive: true });
    await fs.writeFile(
      a.configPath,
      JSON.stringify({
        mcp: {
          servers: [
            { name: 'coderover', command: 'x', args: [], env: {} },
            { name: 'other', command: 'y', args: [], env: {} },
          ],
        },
      }),
    );
    await a.removeMcpEntry();
    const doc = JSON.parse(await fs.readFile(a.configPath, 'utf8'));
    const names = doc.mcp.servers.map((s: { name: string }) => s.name);
    expect(names).toEqual(['other']);
  });

  it('hasMcpEntry roundtrip', async () => {
    const home = await mkHome();
    const a = new GeminiCliAdapter(home);
    expect(await a.hasMcpEntry()).toBe(false);
    await a.writeMcpEntry(entry);
    expect(await a.hasMcpEntry()).toBe(true);
    await a.removeMcpEntry();
    expect(await a.hasMcpEntry()).toBe(false);
  });
});
