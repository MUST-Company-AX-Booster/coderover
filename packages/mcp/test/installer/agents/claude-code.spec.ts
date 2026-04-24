/**
 * ClaudeCodeAdapter tests.
 *
 * Covers: detect / read / write / remove. Every write must preserve unrelated
 * top-level keys and sibling entries under `mcpServers`.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeCodeAdapter } from '../../../src/installer/agents/claude-code';
import { buildRemoteEntry } from '../../../src/installer/agents/base';

async function mkHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'coderover-claude-'));
}

const entry = buildRemoteEntry({
  apiUrl: 'https://api.example.com',
  token: 'tok_abc',
});

describe('ClaudeCodeAdapter', () => {
  it('resolves configPath under ~/.claude/config.json', async () => {
    const home = await mkHome();
    const a = new ClaudeCodeAdapter(home);
    expect(a.configPath).toBe(path.join(home, '.claude', 'config.json'));
  });

  it('configExists=false when the file is missing', async () => {
    const home = await mkHome();
    const a = new ClaudeCodeAdapter(home);
    expect(await a.configExists()).toBe(false);
  });

  it('writes a fresh config when none exists', async () => {
    const home = await mkHome();
    const a = new ClaudeCodeAdapter(home);
    await a.writeMcpEntry(entry);
    const text = await fs.readFile(a.configPath, 'utf8');
    const doc = JSON.parse(text);
    expect(doc.mcpServers.coderover.command).toBe('npx');
    expect(doc.mcpServers.coderover.env.CODEROVER_API_URL).toBe(
      'https://api.example.com',
    );
  });

  it('preserves unrelated top-level keys and sibling servers on write', async () => {
    const home = await mkHome();
    const a = new ClaudeCodeAdapter(home);
    await fs.mkdir(path.dirname(a.configPath), { recursive: true });
    await fs.writeFile(
      a.configPath,
      JSON.stringify({
        theme: 'dark',
        mcpServers: {
          other: { command: 'node', args: ['other.js'], env: {} },
        },
      }),
    );
    await a.writeMcpEntry(entry);
    const doc = JSON.parse(await fs.readFile(a.configPath, 'utf8'));
    expect(doc.theme).toBe('dark');
    expect(doc.mcpServers.other.command).toBe('node');
    expect(doc.mcpServers.coderover.command).toBe('npx');
  });

  it('replaces an existing coderover entry rather than duplicating', async () => {
    const home = await mkHome();
    const a = new ClaudeCodeAdapter(home);
    await fs.mkdir(path.dirname(a.configPath), { recursive: true });
    await fs.writeFile(
      a.configPath,
      JSON.stringify({
        mcpServers: {
          coderover: { command: 'OLD', args: [], env: {} },
        },
      }),
    );
    await a.writeMcpEntry(entry);
    const doc = JSON.parse(await fs.readFile(a.configPath, 'utf8'));
    expect(doc.mcpServers.coderover.command).toBe('npx');
  });

  it('hasMcpEntry detects a coderover entry', async () => {
    const home = await mkHome();
    const a = new ClaudeCodeAdapter(home);
    await a.writeMcpEntry(entry);
    expect(await a.hasMcpEntry()).toBe(true);
  });

  it('hasMcpEntry returns false when config has no coderover', async () => {
    const home = await mkHome();
    const a = new ClaudeCodeAdapter(home);
    await fs.mkdir(path.dirname(a.configPath), { recursive: true });
    await fs.writeFile(a.configPath, JSON.stringify({ theme: 'dark' }));
    expect(await a.hasMcpEntry()).toBe(false);
  });

  it('removeMcpEntry leaves sibling servers intact', async () => {
    const home = await mkHome();
    const a = new ClaudeCodeAdapter(home);
    await fs.mkdir(path.dirname(a.configPath), { recursive: true });
    await fs.writeFile(
      a.configPath,
      JSON.stringify({
        mcpServers: {
          coderover: { command: 'x', args: [], env: {} },
          other: { command: 'y', args: [], env: {} },
        },
      }),
    );
    await a.removeMcpEntry();
    const doc = JSON.parse(await fs.readFile(a.configPath, 'utf8'));
    expect(doc.mcpServers.coderover).toBeUndefined();
    expect(doc.mcpServers.other.command).toBe('y');
  });

  it('removeMcpEntry drops mcpServers when coderover was the only key', async () => {
    const home = await mkHome();
    const a = new ClaudeCodeAdapter(home);
    await a.writeMcpEntry(entry);
    await a.removeMcpEntry();
    const doc = JSON.parse(await fs.readFile(a.configPath, 'utf8'));
    expect(doc.mcpServers).toBeUndefined();
  });

  it('readConfig returns null if config is missing', async () => {
    const home = await mkHome();
    const a = new ClaudeCodeAdapter(home);
    expect(await a.readConfig()).toBeNull();
  });
});
