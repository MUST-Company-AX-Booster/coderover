/**
 * Gemini CLI adapter.
 *
 * Config: `~/.gemini/settings.json`. Gemini stores MCP servers as an ARRAY
 * under `mcp.servers[]` (unlike Claude/Cursor which use a map). Entry identity
 * is the `name` field — we replace/add by name.
 */

import * as os from 'os';
import * as path from 'path';
import type { AgentId, McpServerEntry } from '../types';
import { CODEROVER_ENTRY_KEY } from '../types';
import { BaseAgentAdapter } from './base';
import { parseJsonObject } from './claude-code';

interface GeminiServerEntry {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export class GeminiCliAdapter extends BaseAgentAdapter {
  readonly name: AgentId = 'gemini-cli';
  readonly configPath: string;

  constructor(homeDir: string = os.homedir()) {
    super();
    this.configPath = path.join(homeDir, '.gemini', 'settings.json');
  }

  protected parse(text: string): unknown {
    return JSON.parse(text);
  }

  protected render(originalText: string | null, entry: McpServerEntry): string {
    const doc = parseJsonObject(originalText);
    const mcp =
      (doc.mcp as { servers?: GeminiServerEntry[] } | undefined) ?? {};
    const servers: GeminiServerEntry[] = Array.isArray(mcp.servers)
      ? (mcp.servers as GeminiServerEntry[])
      : [];
    const filtered = servers.filter((s) => s && s.name !== CODEROVER_ENTRY_KEY);
    filtered.push({
      name: CODEROVER_ENTRY_KEY,
      command: entry.command,
      args: entry.args,
      env: entry.env,
    });
    mcp.servers = filtered;
    doc.mcp = mcp;
    return JSON.stringify(doc, null, 2) + '\n';
  }

  protected stripEntry(originalText: string): string | null {
    const doc = parseJsonObject(originalText);
    const mcp = doc.mcp as { servers?: GeminiServerEntry[] } | undefined;
    if (!mcp || !Array.isArray(mcp.servers)) return null;
    const before = mcp.servers.length;
    mcp.servers = mcp.servers.filter(
      (s) => s && s.name !== CODEROVER_ENTRY_KEY,
    );
    if (mcp.servers.length === before) return null;
    if (mcp.servers.length === 0) {
      delete (mcp as Record<string, unknown>).servers;
    }
    if (Object.keys(mcp).length === 0) {
      delete doc.mcp;
    }
    return JSON.stringify(doc, null, 2) + '\n';
  }

  protected detectEntry(text: string): boolean {
    try {
      const doc = JSON.parse(text);
      const servers = doc?.mcp?.servers;
      if (!Array.isArray(servers)) return false;
      return servers.some(
        (s: { name?: string } | null) => s && s.name === CODEROVER_ENTRY_KEY,
      );
    } catch {
      return false;
    }
  }
}
