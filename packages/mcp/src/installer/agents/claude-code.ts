/**
 * Claude Code adapter.
 *
 * Config: `~/.claude/config.json`. We merge into `mcpServers.coderover`.
 * Preserves every other top-level key AND every other entry under
 * `mcpServers.*`.
 *
 * Format: JSON. We preserve key ordering as much as possible by using plain
 * object mutation + 2-space JSON.stringify (Claude Code itself writes the
 * file with 2-space indent).
 */

import * as os from 'os';
import * as path from 'path';
import type { AgentId, McpServerEntry } from '../types';
import { CODEROVER_ENTRY_KEY } from '../types';
import { BaseAgentAdapter } from './base';

export class ClaudeCodeAdapter extends BaseAgentAdapter {
  readonly name: AgentId = 'claude-code';
  readonly configPath: string;

  constructor(homeDir: string = os.homedir()) {
    super();
    this.configPath = path.join(homeDir, '.claude', 'config.json');
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

/** JSON.parse wrapper that tolerates empty/missing text. */
export function parseJsonObject(text: string | null): Record<string, unknown> {
  if (!text || text.trim() === '') return {};
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object at the top level');
  }
  return parsed as Record<string, unknown>;
}
