/**
 * Installer shared types.
 *
 * An `AgentAdapter` knows where a given MCP-capable agent keeps its config
 * (JSON / YAML / TOML) and how to merge a `coderover` entry into it without
 * touching unrelated keys. One adapter per agent — see `./agents/*`.
 */

/** Shape of the MCP entry we write for remote mode. */
export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Identifier used on the CLI (`install claude-code`). */
export type AgentId =
  | 'claude-code'
  | 'cursor'
  | 'aider'
  | 'codex'
  | 'gemini-cli';

export interface AgentAdapter {
  readonly name: AgentId;
  /** Absolute, OS-resolved config path this adapter would write to. */
  readonly configPath: string;
  configExists(): Promise<boolean>;
  readConfig(): Promise<unknown>;
  writeMcpEntry(entry: McpServerEntry): Promise<void>;
  removeMcpEntry(): Promise<void>;
  hasMcpEntry(): Promise<boolean>;
}

/** Stable key under which all adapters store the CodeRover entry. */
export const CODEROVER_ENTRY_KEY = 'coderover';
