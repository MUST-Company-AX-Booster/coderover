/**
 * CursorAdapter tests. Cursor uses the same JSON-map shape as Claude Code so
 * we cover the core cases and lean on claude-code.spec.ts for the full matrix.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CursorAdapter } from '../../../src/installer/agents/cursor';
import { buildRemoteEntry } from '../../../src/installer/agents/base';

async function mkHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'coderover-cursor-'));
}

const entry = buildRemoteEntry({
  apiUrl: 'https://api.example.com',
  token: 'tok_xyz',
});

describe('CursorAdapter', () => {
  it('resolves configPath under ~/.cursor/mcp.json', async () => {
    const home = await mkHome();
    const a = new CursorAdapter(home);
    expect(a.configPath).toBe(path.join(home, '.cursor', 'mcp.json'));
  });

  it('writes fresh config when none exists', async () => {
    const home = await mkHome();
    const a = new CursorAdapter(home);
    await a.writeMcpEntry(entry);
    const doc = JSON.parse(await fs.readFile(a.configPath, 'utf8'));
    expect(doc.mcpServers.coderover.env.CODEROVER_API_TOKEN).toBe('tok_xyz');
  });

  it('preserves sibling mcpServers on write', async () => {
    const home = await mkHome();
    const a = new CursorAdapter(home);
    await fs.mkdir(path.dirname(a.configPath), { recursive: true });
    await fs.writeFile(
      a.configPath,
      JSON.stringify({
        mcpServers: {
          linear: { command: 'npx', args: ['@linear/mcp'], env: {} },
        },
      }),
    );
    await a.writeMcpEntry(entry);
    const doc = JSON.parse(await fs.readFile(a.configPath, 'utf8'));
    expect(doc.mcpServers.linear).toBeDefined();
    expect(doc.mcpServers.coderover).toBeDefined();
  });

  it('removes only the coderover key', async () => {
    const home = await mkHome();
    const a = new CursorAdapter(home);
    await fs.mkdir(path.dirname(a.configPath), { recursive: true });
    await fs.writeFile(
      a.configPath,
      JSON.stringify({
        mcpServers: {
          coderover: { command: 'old', args: [], env: {} },
          linear: { command: 'npx', args: ['@linear/mcp'], env: {} },
        },
      }),
    );
    await a.removeMcpEntry();
    const doc = JSON.parse(await fs.readFile(a.configPath, 'utf8'));
    expect(doc.mcpServers.coderover).toBeUndefined();
    expect(doc.mcpServers.linear).toBeDefined();
  });

  it('hasMcpEntry roundtrip', async () => {
    const home = await mkHome();
    const a = new CursorAdapter(home);
    expect(await a.hasMcpEntry()).toBe(false);
    await a.writeMcpEntry(entry);
    expect(await a.hasMcpEntry()).toBe(true);
    await a.removeMcpEntry();
    expect(await a.hasMcpEntry()).toBe(false);
  });
});
