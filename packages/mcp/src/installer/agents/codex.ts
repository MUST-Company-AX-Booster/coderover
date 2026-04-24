/**
 * Codex adapter.
 *
 * Codex (OpenAI's agent CLI) reads MCP config from TOML. Two paths, in order:
 *   1. `~/.config/codex/mcp.toml`  (XDG — preferred, and what we create on
 *      a fresh install)
 *   2. `~/.codex/config.toml`      (legacy — respected if it exists and the
 *      XDG path does not)
 *
 * We write to whichever path exists. If neither exists, we create (1).
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentId, McpServerEntry } from '../types';
import { BaseAgentAdapter } from './base';
import {
  upsertCodexEntry,
  removeCodexEntry,
  hasCodexEntry,
} from '../toml-lite';

export class CodexAdapter extends BaseAgentAdapter {
  readonly name: AgentId = 'codex';
  readonly xdgPath: string;
  readonly legacyPath: string;
  /**
   * Primary path surfaced to consumers (help text, dry-run output). Actual
   * writes may land at `legacyPath` when only that file exists — see
   * `resolveWritePath()`.
   */
  readonly configPath: string;

  constructor(homeDir: string = os.homedir()) {
    super();
    this.xdgPath = path.join(homeDir, '.config', 'codex', 'mcp.toml');
    this.legacyPath = path.join(homeDir, '.codex', 'config.toml');
    this.configPath = this.xdgPath;
  }

  /** Picks legacy if it exists AND xdg does not; otherwise xdg. */
  async resolveWritePath(): Promise<string> {
    const xdgExists = await exists(this.xdgPath);
    if (xdgExists) return this.xdgPath;
    const legacyExists = await exists(this.legacyPath);
    if (legacyExists) return this.legacyPath;
    return this.xdgPath;
  }

  async configExists(): Promise<boolean> {
    return (await exists(this.xdgPath)) || (await exists(this.legacyPath));
  }

  async readConfig(): Promise<unknown> {
    const p = await this.resolveWritePath();
    if (!(await exists(p))) return null;
    return fs.readFile(p, 'utf8');
  }

  async writeMcpEntry(entry: McpServerEntry): Promise<void> {
    const p = await this.resolveWritePath();
    const original = (await exists(p)) ? await fs.readFile(p, 'utf8') : null;
    const next = upsertCodexEntry(original, entry);
    // Go through the base class atomic write helper by routing through render
    // for the selected path. We can't reuse the base impl because it targets
    // a single `configPath` — Codex has two.
    const { atomicWrite } = await import('../atomic-write');
    await atomicWrite(p, next);
  }

  async removeMcpEntry(): Promise<void> {
    for (const p of [this.xdgPath, this.legacyPath]) {
      if (!(await exists(p))) continue;
      const text = await fs.readFile(p, 'utf8');
      if (!hasCodexEntry(text)) continue;
      const next = removeCodexEntry(text);
      const { atomicWrite } = await import('../atomic-write');
      if (next === '') {
        // File was only our entry — truncate to empty TOML instead of deleting,
        // so we don't nuke a file the user owns.
        await atomicWrite(p, '');
      } else {
        await atomicWrite(p, next);
      }
    }
  }

  async hasMcpEntry(): Promise<boolean> {
    for (const p of [this.xdgPath, this.legacyPath]) {
      if (!(await exists(p))) continue;
      const text = await fs.readFile(p, 'utf8');
      if (hasCodexEntry(text)) return true;
    }
    return false;
  }

  protected parse(text: string): unknown {
    return text;
  }
  protected render(originalText: string | null, entry: McpServerEntry): string {
    return upsertCodexEntry(originalText, entry);
  }
  protected stripEntry(originalText: string): string | null {
    if (!hasCodexEntry(originalText)) return null;
    return removeCodexEntry(originalText);
  }
  protected detectEntry(text: string): boolean {
    return hasCodexEntry(text);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
