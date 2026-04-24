/**
 * Shared base for agent adapters.
 *
 * Each concrete adapter knows:
 *   1. where its config file lives (`resolveConfigPath` per OS)
 *   2. the format (JSON / YAML / TOML)
 *   3. the nested key where the MCP entry belongs
 *
 * This base handles the boring bits: existence checks, reading, and writing
 * via `atomicWrite`.
 */

import { promises as fs } from 'fs';
import type { AgentAdapter, AgentId, McpServerEntry } from '../types';
import { atomicWrite } from '../atomic-write';

export abstract class BaseAgentAdapter implements AgentAdapter {
  abstract readonly name: AgentId;
  abstract readonly configPath: string;

  async configExists(): Promise<boolean> {
    try {
      await fs.access(this.configPath);
      return true;
    } catch {
      return false;
    }
  }

  async readConfig(): Promise<unknown> {
    if (!(await this.configExists())) return null;
    const text = await fs.readFile(this.configPath, 'utf8');
    return this.parse(text);
  }

  async writeMcpEntry(entry: McpServerEntry): Promise<void> {
    const original = (await this.configExists())
      ? await fs.readFile(this.configPath, 'utf8')
      : null;
    const next = this.render(original, entry);
    await atomicWrite(this.configPath, next);
  }

  async removeMcpEntry(): Promise<void> {
    if (!(await this.configExists())) return;
    const original = await fs.readFile(this.configPath, 'utf8');
    const next = this.stripEntry(original);
    if (next === null) {
      // Nothing left to write and nothing to keep — leave the file alone so
      // we never delete a user file we didn't create.
      return;
    }
    await atomicWrite(this.configPath, next);
  }

  async hasMcpEntry(): Promise<boolean> {
    if (!(await this.configExists())) return false;
    const text = await fs.readFile(this.configPath, 'utf8');
    return this.detectEntry(text);
  }

  /** Parse raw text into the adapter's internal representation. */
  protected abstract parse(text: string): unknown;

  /** Render the config back to text, replacing/adding the coderover entry. */
  protected abstract render(
    originalText: string | null,
    entry: McpServerEntry,
  ): string;

  /** Remove the coderover entry; return new text, or null to leave the file
   * unchanged (only when there was nothing to remove). */
  protected abstract stripEntry(originalText: string): string | null;

  /** Fast detection from raw text — does this config reference coderover? */
  protected abstract detectEntry(text: string): boolean;
}

/** Build the remote-mode entry shape. */
export function buildRemoteEntry(opts: {
  apiUrl: string;
  token: string;
  /** Pin version; default `latest`. */
  packageVersion?: string;
}): McpServerEntry {
  const pkg = opts.packageVersion
    ? `@coderover/mcp@${opts.packageVersion}`
    : '@coderover/mcp@latest';
  return {
    command: 'npx',
    args: [pkg],
    env: {
      CODEROVER_API_URL: opts.apiUrl,
      CODEROVER_API_TOKEN: opts.token,
    },
  };
}

/**
 * Build the local-mode entry shape.
 *
 * Local mode skips the remote API and reads a per-project SQLite database
 * maintained by `coderover index` / `coderover watch`. The spawned binary is
 * the same (`npx @coderover/mcp@latest`) — only the env vars differ, telling
 * the server to boot `LocalTransport` instead of the HTTP-backed one.
 */
export function buildLocalEntry(opts: {
  dbPath: string;
  embedMode?: 'openai' | 'mock' | 'offline';
  /** Pin version; default `latest`. */
  packageVersion?: string;
}): McpServerEntry {
  const pkg = opts.packageVersion
    ? `@coderover/mcp@${opts.packageVersion}`
    : '@coderover/mcp@latest';
  return {
    command: 'npx',
    args: [pkg],
    env: {
      CODEROVER_MODE: 'local',
      CODEROVER_LOCAL_DB: opts.dbPath,
      CODEROVER_EMBED_MODE: opts.embedMode ?? 'openai',
    },
  };
}
