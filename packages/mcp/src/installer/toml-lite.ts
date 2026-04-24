/**
 * Hand-rolled, scope-limited TOML reader/writer for Codex's mcp config.
 *
 * We only need to round-trip the shape:
 *
 *     [mcp.servers.coderover]
 *     command = "npx"
 *     args = ["@coderover/mcp@latest"]
 *
 *     [mcp.servers.coderover.env]
 *     CODEROVER_API_URL = "https://..."
 *     CODEROVER_API_TOKEN = "..."
 *
 * Sibling tables (other `[section]` blocks, including other
 * `[mcp.servers.<x>]` servers the user set up) MUST be preserved verbatim. We
 * do that by never re-emitting them — they stay as the original lines, and we
 * only splice the `[mcp.servers.coderover...]` sub-tree.
 *
 * This is NOT a general TOML parser. If the file contains genuinely weird
 * TOML we still preserve it byte-for-byte because we only rewrite the
 * coderover-specific section headers + lines.
 */

import type { McpServerEntry } from './types';
import { CODEROVER_ENTRY_KEY } from './types';

const CODEROVER_HEADER_RE = /^\s*\[mcp\.servers\.coderover(?:\.env)?\]\s*$/;
const ANY_HEADER_RE = /^\s*\[([^\]]+)\]\s*$/;

/**
 * Return the TOML text for `~/.config/codex/mcp.toml` (or legacy path) after
 * replacing the `[mcp.servers.coderover]` sub-tree. Any other table is kept
 * byte-identical.
 *
 * If `original` is null (file doesn't exist), we return a fresh document.
 */
export function upsertCodexEntry(
  original: string | null,
  entry: McpServerEntry,
): string {
  const keptLines: string[] = [];
  if (original) {
    const lines = original.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    let inCoderover = false;
    for (const line of lines) {
      const isHeader = ANY_HEADER_RE.test(line);
      if (isHeader) {
        inCoderover = CODEROVER_HEADER_RE.test(line);
        if (inCoderover) continue;
      }
      if (inCoderover) continue;
      keptLines.push(line);
    }
    while (keptLines.length > 0 && keptLines[keptLines.length - 1] === '') {
      keptLines.pop();
    }
  }

  const entryBlock = renderCodexEntry(entry);
  if (keptLines.length === 0) {
    return entryBlock + '\n';
  }
  return keptLines.join('\n') + '\n\n' + entryBlock + '\n';
}

/**
 * Strip the `[mcp.servers.coderover]` sub-tree. Returns the resulting text,
 * or empty string if the file only contained that sub-tree.
 */
export function removeCodexEntry(original: string): string {
  const lines = original.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const kept: string[] = [];
  let inCoderover = false;
  for (const line of lines) {
    const isHeader = ANY_HEADER_RE.test(line);
    if (isHeader) {
      inCoderover = CODEROVER_HEADER_RE.test(line);
      if (inCoderover) continue;
    }
    if (inCoderover) continue;
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  return kept.length === 0 ? '' : kept.join('\n') + '\n';
}

/**
 * Return `true` iff the TOML text contains a `[mcp.servers.coderover]` or
 * `[mcp.servers.coderover.env]` header.
 */
export function hasCodexEntry(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (CODEROVER_HEADER_RE.test(line)) return true;
  }
  return false;
}

function renderCodexEntry(entry: McpServerEntry): string {
  const out: string[] = [];
  out.push(`[mcp.servers.${CODEROVER_ENTRY_KEY}]`);
  out.push(`command = ${tomlString(entry.command)}`);
  out.push(`args = ${tomlArray(entry.args)}`);
  const envKeys = Object.keys(entry.env);
  if (envKeys.length > 0) {
    out.push('');
    out.push(`[mcp.servers.${CODEROVER_ENTRY_KEY}.env]`);
    for (const k of envKeys) {
      out.push(`${tomlBareKey(k)} = ${tomlString(entry.env[k]!)}`);
    }
  }
  return out.join('\n');
}

function tomlString(v: string): string {
  return `"${v
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

/** Bare keys must match [A-Za-z0-9_-]+ per TOML spec. Anything else → quoted. */
function tomlBareKey(k: string): string {
  if (/^[A-Za-z0-9_\-]+$/.test(k)) return k;
  return tomlString(k);
}
