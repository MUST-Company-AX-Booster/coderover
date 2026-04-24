/**
 * Aider adapter.
 *
 * Config: `~/.aider.conf.yml`. Aider supports `mcp-servers:` as a list of
 * servers (each is a map with name/command/args/env). We add/replace the
 * entry identified by `name: coderover`.
 *
 * YAML round-trip uses the scope-limited `yaml-lite` in this package (no
 * `js-yaml` runtime dep).
 */

import * as os from 'os';
import * as path from 'path';
import type { AgentId, McpServerEntry } from '../types';
import { BaseAgentAdapter } from './base';
import { upsertAiderEntry, removeAiderEntry, parseAiderYaml } from '../yaml-lite';
import { CODEROVER_ENTRY_KEY } from '../types';

export class AiderAdapter extends BaseAgentAdapter {
  readonly name: AgentId = 'aider';
  readonly configPath: string;

  constructor(homeDir: string = os.homedir()) {
    super();
    this.configPath = path.join(homeDir, '.aider.conf.yml');
  }

  protected parse(text: string): unknown {
    return parseAiderYaml(text);
  }

  protected render(originalText: string | null, entry: McpServerEntry): string {
    return upsertAiderEntry(originalText, entry);
  }

  protected stripEntry(originalText: string): string | null {
    const doc = parseAiderYaml(originalText);
    const had = doc.mcpServers.some((s) => s.name === CODEROVER_ENTRY_KEY);
    if (!had) return null;
    return removeAiderEntry(originalText);
  }

  protected detectEntry(text: string): boolean {
    try {
      const doc = parseAiderYaml(text);
      return doc.mcpServers.some((s) => s.name === CODEROVER_ENTRY_KEY);
    } catch {
      return false;
    }
  }
}
