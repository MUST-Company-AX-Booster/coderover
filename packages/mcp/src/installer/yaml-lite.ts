/**
 * Hand-rolled, scope-limited YAML reader/writer for `.aider.conf.yml`.
 *
 * We deliberately do NOT pull in `js-yaml` (not in our package tree, zero-dep
 * rule). The aider config is a flat map of scalars plus an `mcp-servers:` list
 * we control. That's the only structure we need to round-trip.
 *
 * Supported input subset (enough to preserve sibling keys without touching
 * them):
 *   - `key: scalar`  (string | number | bool | null via `~`)
 *   - `key: "quoted string"`
 *   - `key:` followed by a list of `- items` (each item is a map or scalar)
 *   - `# comments` — preserved for top-level keys we do NOT rewrite; the
 *     aider entry we rewrite is emitted fresh
 *   - blank lines — preserved at top level
 *
 * Strategy: parse top-level blocks by scanning leading column. For each block,
 * decide whether it's the `mcp-servers:` block we manage (replace) or an
 * opaque block we keep as-is (preserve original lines). This avoids writing a
 * full YAML parser.
 */

import type { McpServerEntry } from './types';
import { CODEROVER_ENTRY_KEY } from './types';

/** Parsed representation of an `.aider.conf.yml` with our key extracted. */
export interface AiderYamlDoc {
  /** Raw lines that are NOT part of `mcp-servers:`. Order preserved. */
  otherBlocks: string[];
  /** Parsed list of MCP server entries (by `name`) present in the file. */
  mcpServers: AiderMcpServerEntry[];
  /** True iff the file had a `mcp-servers:` key. */
  hadMcpServers: boolean;
}

export interface AiderMcpServerEntry {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Parse `.aider.conf.yml` text into a doc we can mutate safely.
 *
 * Unknown top-level blocks (anything other than `mcp-servers:`) are stashed
 * verbatim as `otherBlocks` so we never corrupt sibling keys. Any comments /
 * blank lines between blocks stay glued to the block above them.
 */
export function parseAiderYaml(text: string): AiderYamlDoc {
  const lines = text.split(/\r?\n/);
  const otherBlocks: string[] = [];
  const mcpServers: AiderMcpServerEntry[] = [];
  let hadMcpServers = false;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (i === lines.length - 1 && line === '') {
      i++;
      continue;
    }

    const topMatch = /^([A-Za-z0-9_][A-Za-z0-9_\-]*)\s*:\s*(.*)$/.exec(line);
    if (topMatch && !line.startsWith(' ') && !line.startsWith('\t')) {
      const key = topMatch[1]!;
      if (key === 'mcp-servers') {
        hadMcpServers = true;
        i++;
        const blockLines: string[] = [];
        while (i < lines.length) {
          const peek = lines[i]!;
          if (
            peek.length > 0 &&
            !peek.startsWith(' ') &&
            !peek.startsWith('\t') &&
            /^([A-Za-z0-9_][A-Za-z0-9_\-]*)\s*:/.test(peek)
          ) {
            break;
          }
          blockLines.push(peek);
          i++;
        }
        mcpServers.push(...parseMcpServersBlock(blockLines));
        continue;
      }
    }

    const chunk: string[] = [line];
    i++;
    while (i < lines.length) {
      const peek = lines[i]!;
      if (
        peek.length > 0 &&
        !peek.startsWith(' ') &&
        !peek.startsWith('\t') &&
        /^([A-Za-z0-9_][A-Za-z0-9_\-]*)\s*:/.test(peek)
      ) {
        break;
      }
      chunk.push(peek);
      i++;
    }
    otherBlocks.push(chunk.join('\n'));
  }

  return { otherBlocks, mcpServers, hadMcpServers };
}

/**
 * Parse the body of `mcp-servers:` into entries. Matches the shape we emit
 * (name / command / args list / env map), which is the only shape we need
 * to round-trip.
 */
function parseMcpServersBlock(blockLines: string[]): AiderMcpServerEntry[] {
  const entries: AiderMcpServerEntry[] = [];
  let cur: AiderMcpServerEntry | null = null;
  let mode: 'idle' | 'args' | 'env' = 'idle';

  for (const rawLine of blockLines) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const itemMatch = /^\s*-\s*(.*)$/.exec(line);
    if (itemMatch && /^\s*-/.test(line)) {
      if (cur) entries.push(cur);
      cur = { name: '' };
      mode = 'idle';
      const rest = itemMatch[1]!;
      const kv = /^([A-Za-z0-9_][A-Za-z0-9_\-]*)\s*:\s*(.*)$/.exec(rest);
      if (kv) applyKv(cur, kv[1]!, kv[2]!);
      continue;
    }

    if (!cur) continue;

    const kv = /^\s+([A-Za-z0-9_][A-Za-z0-9_\-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      const k = kv[1]!;
      const v = kv[2]!;
      if (v === '' && k === 'args') {
        mode = 'args';
        cur.args = [];
      } else if (v === '' && k === 'env') {
        mode = 'env';
        cur.env = {};
      } else {
        mode = 'idle';
        applyKv(cur, k, v);
      }
      continue;
    }

    const argMatch = /^\s+-\s*(.*)$/.exec(line);
    if (argMatch && mode === 'args') {
      cur.args ??= [];
      cur.args.push(unquote(argMatch[1]!.trim()));
      continue;
    }

    const envMatch = /^\s+([A-Za-z0-9_][A-Za-z0-9_\-]*)\s*:\s*(.*)$/.exec(line);
    if (envMatch && mode === 'env') {
      cur.env ??= {};
      cur.env[envMatch[1]!] = unquote(envMatch[2]!.trim());
      continue;
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

function applyKv(e: AiderMcpServerEntry, k: string, v: string): void {
  const val = unquote(v.trim());
  if (k === 'name') e.name = val;
  else if (k === 'command') e.command = val;
}

function unquote(v: string): string {
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

/**
 * Replace (or add) the `coderover` entry under `mcp-servers:` and return
 * the serialized YAML text. Non-coderover entries and sibling blocks are
 * preserved verbatim.
 */
export function upsertAiderEntry(
  original: string | null,
  entry: McpServerEntry,
): string {
  const doc = original
    ? parseAiderYaml(original)
    : { otherBlocks: [], mcpServers: [], hadMcpServers: false };

  const filtered = doc.mcpServers.filter((s) => s.name !== CODEROVER_ENTRY_KEY);
  filtered.push({
    name: CODEROVER_ENTRY_KEY,
    command: entry.command,
    args: entry.args,
    env: entry.env,
  });

  return serializeAiderYaml(doc.otherBlocks, filtered);
}

/** Remove the `coderover` entry; returns serialized text (may be empty). */
export function removeAiderEntry(original: string): string {
  const doc = parseAiderYaml(original);
  const filtered = doc.mcpServers.filter((s) => s.name !== CODEROVER_ENTRY_KEY);
  return serializeAiderYaml(doc.otherBlocks, filtered);
}

function serializeAiderYaml(
  otherBlocks: string[],
  servers: AiderMcpServerEntry[],
): string {
  const out: string[] = [];

  for (const block of otherBlocks) {
    out.push(block.replace(/\n+$/, ''));
  }

  if (servers.length > 0) {
    if (out.length > 0) out.push('');
    out.push('mcp-servers:');
    for (const s of servers) {
      out.push(`  - name: ${yamlScalar(s.name)}`);
      if (s.command !== undefined) {
        out.push(`    command: ${yamlScalar(s.command)}`);
      }
      if (s.args && s.args.length > 0) {
        out.push(`    args:`);
        for (const a of s.args) out.push(`      - ${yamlScalar(a)}`);
      }
      if (s.env && Object.keys(s.env).length > 0) {
        out.push(`    env:`);
        for (const [k, v] of Object.entries(s.env)) {
          out.push(`      ${k}: ${yamlScalar(v)}`);
        }
      }
    }
  }

  return out.join('\n') + '\n';
}

/**
 * Quote a scalar iff needed.
 *
 * Plain URL scalars (`https://...`) are allowed unquoted because the `:` is
 * not followed by whitespace, which is what YAML 1.2 uses to distinguish a
 * mapping key from an embedded colon. We DO quote values that start with a
 * YAML reserved indicator or that embed `: ` / newlines / leading dash.
 */
function yamlScalar(v: string): string {
  if (v === '') return '""';
  if (/^[\s\-?:,\[\]{}#&*!|>'%@`"]/.test(v)) return quote(v);
  if (/[\n\r\t]/.test(v)) return quote(v);
  if (/:\s|\s#/.test(v)) return quote(v);
  // Keep `@` safe when at start (reserved).
  if (v.startsWith('@')) return quote(v);
  return v;
}

function quote(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
