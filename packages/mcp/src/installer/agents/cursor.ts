/**
 * Cursor adapter.
 *
 * Config: `~/.cursor/mcp.json`. Same shape as Claude Code:
 *
 *   { "mcpServers": { "coderover": { ... }, ... } }
 *
 * Cursor reads this file on startup — no live-reload — so after install we
 * emit a "restart Cursor" hint in the CLI.
 */

import * as os from 'os';
import * as path from 'path';
import type { AgentId, McpServerEntry } from '../types';
import { CODEROVER_ENTRY_KEY } from '../types';
import { BaseAgentAdapter } from './base';
import { parseJsonObject } from './claude-code';

export class CursorAdapter extends BaseAgentAdapter {
  readonly name: AgentId = 'cursor';
  readonly configPath: string;

  constructor(homeDir: string = os.homedir()) {
    super();
    this.configPath = path.join(homeDir, '.cursor', 'mcp.json');
  }

  protected parse(text: string): unknown {
    return JSON.parse(text);
  }

  protected render(originalText: string | null, entry: McpServerEntry): string {
    const doc = parseJsonObject(originalText);
    const servers =
      (doc.mcpServers as Record<string, unknown> | undefined) ?? {};
    servers[CODEROVER_ENTRY_KEY] = entry;
    doc.mcpServers = servers;
    return JSON.stringify(doc, null, 2) + '\n';
  }

  protected stripEntry(originalText: string): string | null {
    const doc = parseJsonObject(originalText);
    const servers = doc.mcpServers as Record<string, unknown> | undefined;
    if (!servers || !(CODEROVER_ENTRY_KEY in servers)) return null;
    delete servers[CODEROVER_ENTRY_KEY];
    if (Object.keys(servers).length === 0) {
      delete doc.mcpServers;
    }
    return JSON.stringify(doc, null, 2) + '\n';
  }

  protected detectEntry(text: string): boolean {
    try {
      const doc = JSON.parse(text);
      return Boolean(
        doc &&
          doc.mcpServers &&
          typeof doc.mcpServers === 'object' &&
          CODEROVER_ENTRY_KEY in doc.mcpServers,
      );
    } catch {
      return false;
    }
  }
}
