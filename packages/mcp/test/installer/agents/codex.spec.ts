/**
 * CodexAdapter + toml-lite tests.
 *
 * Codex has two possible config paths (xdg + legacy). We want to verify:
 *   - fresh install lands at the xdg path
 *   - legacy path is respected when only it exists
 *   - siblings outside `[mcp.servers.coderover]` are preserved byte-for-byte
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodexAdapter } from '../../../src/installer/agents/codex';
import { buildRemoteEntry } from '../../../src/installer/agents/base';
import {
  upsertCodexEntry,
  removeCodexEntry,
  hasCodexEntry,
} from '../../../src/installer/toml-lite';

async function mkHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'coderover-codex-'));
}

const entry = buildRemoteEntry({
  apiUrl: 'https://api.example.com',
  token: 'tok_codex',
});

describe('CodexAdapter path resolution', () => {
  it('defaults write path to ~/.config/codex/mcp.toml', async () => {
    const home = await mkHome();
    const a = new CodexAdapter(home);
    expect(await a.resolveWritePath()).toBe(
      path.join(home, '.config', 'codex', 'mcp.toml'),
    );
  });

  it('prefers xdg path when both exist', async () => {
    const home = await mkHome();
    const a = new CodexAdapter(home);
    await fs.mkdir(path.dirname(a.xdgPath), { recursive: true });
    await fs.mkdir(path.dirname(a.legacyPath), { recursive: true });
    await fs.writeFile(a.xdgPath, '');
    await fs.writeFile(a.legacyPath, '');
    expect(await a.resolveWritePath()).toBe(a.xdgPath);
  });

  it('uses legacy path when only it exists', async () => {
    const home = await mkHome();
    const a = new CodexAdapter(home);
    await fs.mkdir(path.dirname(a.legacyPath), { recursive: true });
    await fs.writeFile(a.legacyPath, '# legacy\n');
    expect(await a.resolveWritePath()).toBe(a.legacyPath);
  });
});

describe('CodexAdapter write', () => {
  it('creates xdg path on fresh install', async () => {
    const home = await mkHome();
    const a = new CodexAdapter(home);
    await a.writeMcpEntry(entry);
    const text = await fs.readFile(a.xdgPath, 'utf8');
    expect(text).toContain('[mcp.servers.coderover]');
    expect(text).toContain('command = "npx"');
    expect(text).toContain('args = ["@coderover/mcp@latest"]');
    expect(text).toContain('[mcp.servers.coderover.env]');
    expect(text).toContain('CODEROVER_API_URL = "https://api.example.com"');
  });

  it('preserves sibling [other] tables on write', async () => {
    const home = await mkHome();
    const a = new CodexAdapter(home);
    await fs.mkdir(path.dirname(a.xdgPath), { recursive: true });
    await fs.writeFile(
      a.xdgPath,
      [
        '[profile]',
        'model = "o1"',
        '',
        '[mcp.servers.linear]',
        'command = "linear-mcp"',
        '',
      ].join('\n'),
    );
    await a.writeMcpEntry(entry);
    const text = await fs.readFile(a.xdgPath, 'utf8');
    expect(text).toContain('[profile]');
    expect(text).toContain('model = "o1"');
    expect(text).toContain('[mcp.servers.linear]');
    expect(text).toContain('[mcp.servers.coderover]');
  });

  it('replaces an existing coderover table in place', async () => {
    const home = await mkHome();
    const a = new CodexAdapter(home);
    await fs.mkdir(path.dirname(a.xdgPath), { recursive: true });
    await fs.writeFile(
      a.xdgPath,
      [
        '[mcp.servers.coderover]',
        'command = "OLD"',
        '',
        '[mcp.servers.coderover.env]',
        'CODEROVER_API_URL = "https://old"',
        '',
        '[profile]',
        'model = "o1"',
        '',
      ].join('\n'),
    );
    await a.writeMcpEntry(entry);
    const text = await fs.readFile(a.xdgPath, 'utf8');
    expect(text).not.toMatch(/OLD/);
    expect(text).toContain('command = "npx"');
    expect(text).toContain('[profile]');
  });

  it('writes to legacy path when that is the only one present', async () => {
    const home = await mkHome();
    const a = new CodexAdapter(home);
    await fs.mkdir(path.dirname(a.legacyPath), { recursive: true });
    await fs.writeFile(a.legacyPath, '[profile]\nmodel = "x"\n');
    await a.writeMcpEntry(entry);
    expect(await fs.readFile(a.legacyPath, 'utf8')).toContain(
      '[mcp.servers.coderover]',
    );
    // xdg path was NOT created.
    await expect(fs.access(a.xdgPath)).rejects.toThrow();
  });
});

describe('CodexAdapter remove', () => {
  it('strips the coderover sub-tree only', async () => {
    const home = await mkHome();
    const a = new CodexAdapter(home);
    await a.writeMcpEntry(entry);
    // Append a sibling the user cares about.
    await fs.appendFile(
      a.xdgPath,
      '\n[profile]\nmodel = "o1"\n',
    );
    await a.removeMcpEntry();
    const text = await fs.readFile(a.xdgPath, 'utf8');
    expect(text).not.toContain('coderover');
    expect(text).toContain('[profile]');
    expect(text).toContain('model = "o1"');
  });

  it('hasMcpEntry roundtrip', async () => {
    const home = await mkHome();
    const a = new CodexAdapter(home);
    expect(await a.hasMcpEntry()).toBe(false);
    await a.writeMcpEntry(entry);
    expect(await a.hasMcpEntry()).toBe(true);
    await a.removeMcpEntry();
    expect(await a.hasMcpEntry()).toBe(false);
  });
});

describe('toml-lite round-trip', () => {
  it('upsertCodexEntry fresh doc emits expected text', () => {
    const out = upsertCodexEntry(null, entry);
    expect(out).toContain('[mcp.servers.coderover]');
    expect(out).toContain('[mcp.servers.coderover.env]');
  });

  it('removeCodexEntry returns empty when only our tree existed', () => {
    const original = upsertCodexEntry(null, entry);
    const stripped = removeCodexEntry(original);
    expect(stripped).toBe('');
  });

  it('hasCodexEntry detects both coderover headers', () => {
    expect(
      hasCodexEntry('[mcp.servers.coderover]\ncommand = "x"\n'),
    ).toBe(true);
    expect(
      hasCodexEntry('[mcp.servers.coderover.env]\nCODEROVER_API_URL = "x"\n'),
    ).toBe(true);
    expect(hasCodexEntry('[profile]\nmodel = "o1"\n')).toBe(false);
  });
});
