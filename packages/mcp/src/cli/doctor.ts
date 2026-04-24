/**
 * `coderover-mcp doctor [<agent>]` — diagnostics.
 *
 * Walks the agent registry, for each installed config:
 *   - parses the current entry
 *   - hits `GET <api-url>/mcp/capabilities` with the Bearer token
 *   - measures latency
 *   - renders an actionable check/cross line per agent
 *
 * Exit 0 iff every check passed. Exit 1 on any failure.
 */

import { promises as fs } from 'fs';
import type { AgentAdapter, AgentId } from '../installer/types';
import { makeAdapter, isAgentId, AGENT_IDS } from '../installer/agents';
import type { HttpClient } from '../transport/http-client';
import { compareVersions, MIN_BACKEND_VERSION } from '../protocol';
import { ClaudeCodeAdapter } from '../installer/agents/claude-code';
import { CursorAdapter } from '../installer/agents/cursor';
import { GeminiCliAdapter } from '../installer/agents/gemini-cli';
import { AiderAdapter } from '../installer/agents/aider';
import { CodexAdapter } from '../installer/agents/codex';
import {
  doctorLocal,
  type InstalledLocalEntry,
} from './local/doctor-local';

export interface DoctorOptions {
  /** Filter to a single agent, or all installed agents if undefined. */
  agent?: string;
  apiUrl?: string;
  token?: string;
}

export interface DoctorContext {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
  homeDir?: string;
  nodeVersion: string;
  packageVersion: string;
  makeHttp?: (opts: { baseUrl: string; token?: string }) => HttpClient;
}

export async function runDoctor(
  opts: DoctorOptions,
  ctx: DoctorContext,
): Promise<{ exitCode: number }> {
  ctx.out.write(`node ${ctx.nodeVersion}\n`);
  ctx.out.write(`@coderover/mcp ${ctx.packageVersion}\n\n`);

  const ids: AgentId[] = opts.agent
    ? isAgentId(opts.agent)
      ? [opts.agent]
      : []
    : AGENT_IDS;
  if (opts.agent && ids.length === 0) {
    ctx.err.write(
      `unknown agent "${opts.agent}". Supported: ${AGENT_IDS.join(', ')}\n`,
    );
    return { exitCode: 1 };
  }

  const adapters: AgentAdapter[] = ids.map((id) => makeAdapter(id, ctx.homeDir));

  const installed: AgentAdapter[] = [];
  for (const a of adapters) {
    const present = await a.configExists();
    const hasEntry = present ? await a.hasMcpEntry() : false;
    if (hasEntry) {
      installed.push(a);
    } else if (present) {
      ctx.out.write(`- ${a.name}: config present, no coderover entry.\n`);
    } else {
      ctx.out.write(`- ${a.name}: not installed.\n`);
    }
  }

  if (installed.length === 0) {
    ctx.out.write('\nNo CodeRover entries detected.\n');
    ctx.out.write(
      'Run `npx @coderover/mcp install <agent>` to get started.\n',
    );
    return { exitCode: ids.length === 1 ? 1 : 0 };
  }

  // Partition by mode. An agent whose entry has CODEROVER_MODE=local gets the
  // local doctor; otherwise it's treated as remote (backwards-compatible —
  // pre-local entries have no CODEROVER_MODE key and default to remote).
  const localAgents: Array<{
    adapter: AgentAdapter;
    entry: InstalledLocalEntry;
  }> = [];
  const remoteAgents: AgentAdapter[] = [];
  for (const a of installed) {
    const localEntry = await readLocalEntryFromAgent(a);
    if (localEntry && localEntry.mode === 'local') {
      localAgents.push({ adapter: a, entry: localEntry });
    } else {
      remoteAgents.push(a);
    }
  }

  let failed = 0;

  if (remoteAgents.length > 0) {
    ctx.out.write('\nChecking backend reachability:\n');
    for (const a of remoteAgents) {
      const parsed = await readEntryFromAgent(a);
      const apiUrl = opts.apiUrl ?? parsed?.apiUrl ?? ctx.env.CODEROVER_API_URL;
      const token = opts.token ?? parsed?.token ?? ctx.env.CODEROVER_API_TOKEN;

      if (!apiUrl || !token) {
        ctx.err.write(
          `  x ${a.name}: missing api-url or token (re-run install?)\n`,
        );
        failed++;
        continue;
      }

      if (!ctx.makeHttp) {
        ctx.err.write(
          `  x ${a.name}: no HTTP client available (internal misconfiguration)\n`,
        );
        failed++;
        continue;
      }

      const http = ctx.makeHttp({ baseUrl: apiUrl, token });
      const result = await probeBackend(http);
      if (result.ok) {
        ctx.out.write(`  ok ${a.name}: ${apiUrl} (${result.latencyMs}ms)\n`);
      } else {
        failed++;
        ctx.err.write(`  x ${a.name}: ${apiUrl} — ${result.reason}\n`);
        if (result.hint) ctx.err.write(`      hint: ${result.hint}\n`);
      }
    }
  }

  if (localAgents.length > 0) {
    ctx.out.write('\nChecking local-mode index:\n');
    for (const { adapter, entry } of localAgents) {
      ctx.out.write(`- ${adapter.name}:\n`);
      const report = await doctorLocal(
        { entry, env: ctx.env },
        {},
        { out: ctx.out, err: ctx.err },
      );
      if (!report.passing) failed++;
    }
  }

  return { exitCode: failed === 0 ? 0 : 1 };
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  reason?: string;
  hint?: string;
}

export async function probeBackend(http: HttpClient): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const res = await http.request('GET', '/mcp/capabilities');
    const latencyMs = Date.now() - started;
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        latencyMs,
        reason: `auth failed (${res.status})`,
        hint: 'token revoked or expired — run `install` again',
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        latencyMs,
        reason: `HTTP ${res.status} ${res.statusText}`,
        hint: 'check that the backend is up and the api-url is correct',
      };
    }
    let body: { version?: string } | null = null;
    try {
      body = (await res.json()) as { version?: string };
    } catch {
      return {
        ok: false,
        latencyMs,
        reason: 'capabilities body was not JSON',
        hint: 'backend may be too old or behind a misconfigured proxy',
      };
    }
    if (!body || typeof body.version !== 'string') {
      return {
        ok: false,
        latencyMs,
        reason: 'capabilities response missing version',
        hint: 'backend is too old — upgrade CodeRover',
      };
    }
    if (compareVersions(body.version, MIN_BACKEND_VERSION) < 0) {
      return {
        ok: false,
        latencyMs,
        reason: `backend v${body.version} < min v${MIN_BACKEND_VERSION}`,
        hint: 'upgrade the backend or downgrade @coderover/mcp',
      };
    }
    return { ok: true, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      latencyMs,
      reason,
      hint: 'network unreachable — check VPN / firewall / URL',
    };
  }
}

/**
 * Extract the installed api-url and token from an agent's config (best-effort).
 * Different formats → different extraction paths. Returns null if not found.
 */
export async function readEntryFromAgent(
  a: AgentAdapter,
): Promise<{ apiUrl?: string; token?: string } | null> {
  if (a instanceof ClaudeCodeAdapter || a instanceof CursorAdapter) {
    try {
      const text = await fs.readFile(a.configPath, 'utf8');
      const doc = JSON.parse(text);
      const entry = doc?.mcpServers?.coderover;
      return {
        apiUrl: entry?.env?.CODEROVER_API_URL,
        token: entry?.env?.CODEROVER_API_TOKEN,
      };
    } catch {
      return null;
    }
  }
  if (a instanceof GeminiCliAdapter) {
    try {
      const text = await fs.readFile(a.configPath, 'utf8');
      const doc = JSON.parse(text);
      const servers: Array<{
        name?: string;
        env?: Record<string, string>;
      }> = doc?.mcp?.servers ?? [];
      const entry = servers.find((s) => s && s.name === 'coderover');
      return {
        apiUrl: entry?.env?.CODEROVER_API_URL,
        token: entry?.env?.CODEROVER_API_TOKEN,
      };
    } catch {
      return null;
    }
  }
  if (a instanceof AiderAdapter) {
    try {
      const text = await fs.readFile(a.configPath, 'utf8');
      const { parseAiderYaml } = await import('../installer/yaml-lite');
      const doc = parseAiderYaml(text);
      const entry = doc.mcpServers.find((s) => s.name === 'coderover');
      return {
        apiUrl: entry?.env?.CODEROVER_API_URL,
        token: entry?.env?.CODEROVER_API_TOKEN,
      };
    } catch {
      return null;
    }
  }
  if (a instanceof CodexAdapter) {
    try {
      const p = await a.resolveWritePath();
      const text = await fs.readFile(p, 'utf8');
      return parseCodexEnv(text);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Extract local-mode env values from an agent's installed entry. Returns
 * null if we can't find an entry. The returned object may still have
 * `mode` unset — callers must check `mode === 'local'` explicitly.
 */
export async function readLocalEntryFromAgent(
  a: AgentAdapter,
): Promise<InstalledLocalEntry | null> {
  if (a instanceof ClaudeCodeAdapter || a instanceof CursorAdapter) {
    try {
      const text = await fs.readFile(a.configPath, 'utf8');
      const doc = JSON.parse(text);
      const env = doc?.mcpServers?.coderover?.env ?? {};
      return {
        mode: env.CODEROVER_MODE,
        dbPath: env.CODEROVER_LOCAL_DB,
        embedMode: env.CODEROVER_EMBED_MODE,
      };
    } catch {
      return null;
    }
  }
  if (a instanceof GeminiCliAdapter) {
    try {
      const text = await fs.readFile(a.configPath, 'utf8');
      const doc = JSON.parse(text);
      const servers: Array<{
        name?: string;
        env?: Record<string, string>;
      }> = doc?.mcp?.servers ?? [];
      const entry = servers.find((s) => s && s.name === 'coderover');
      const env = entry?.env ?? {};
      return {
        mode: env.CODEROVER_MODE,
        dbPath: env.CODEROVER_LOCAL_DB,
        embedMode: env.CODEROVER_EMBED_MODE,
      };
    } catch {
      return null;
    }
  }
  if (a instanceof AiderAdapter) {
    try {
      const text = await fs.readFile(a.configPath, 'utf8');
      const { parseAiderYaml } = await import('../installer/yaml-lite');
      const doc = parseAiderYaml(text);
      const entry = doc.mcpServers.find((s) => s.name === 'coderover');
      const env = entry?.env ?? {};
      return {
        mode: env.CODEROVER_MODE,
        dbPath: env.CODEROVER_LOCAL_DB,
        embedMode: env.CODEROVER_EMBED_MODE,
      };
    } catch {
      return null;
    }
  }
  if (a instanceof CodexAdapter) {
    try {
      const p = await a.resolveWritePath();
      const text = await fs.readFile(p, 'utf8');
      return parseCodexLocalEnv(text);
    } catch {
      return null;
    }
  }
  return null;
}

function parseCodexLocalEnv(text: string): InstalledLocalEntry {
  const lines = text.split(/\r?\n/);
  let inEnv = false;
  const out: InstalledLocalEntry = {};
  const envHeader = /^\s*\[mcp\.servers\.coderover\.env\]\s*$/;
  const anyHeader = /^\s*\[[^\]]+\]\s*$/;
  const kv = /^([A-Za-z0-9_\-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/;
  for (const line of lines) {
    if (envHeader.test(line)) {
      inEnv = true;
      continue;
    }
    if (anyHeader.test(line)) {
      inEnv = false;
      continue;
    }
    if (!inEnv) continue;
    const m = line.match(kv);
    if (!m) continue;
    const key = m[1]!;
    const val = m[2]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    if (key === 'CODEROVER_MODE') out.mode = val;
    else if (key === 'CODEROVER_LOCAL_DB') out.dbPath = val;
    else if (key === 'CODEROVER_EMBED_MODE') out.embedMode = val;
  }
  return out;
}

/** Lightweight grep of `[mcp.servers.coderover.env]` values. */
function parseCodexEnv(text: string): { apiUrl?: string; token?: string } {
  const lines = text.split(/\r?\n/);
  let inEnv = false;
  const out: { apiUrl?: string; token?: string } = {};
  const envHeader = /^\s*\[mcp\.servers\.coderover\.env\]\s*$/;
  const anyHeader = /^\s*\[[^\]]+\]\s*$/;
  const kv = /^([A-Za-z0-9_\-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/;
  for (const line of lines) {
    if (envHeader.test(line)) {
      inEnv = true;
      continue;
    }
    if (anyHeader.test(line)) {
      inEnv = false;
      continue;
    }
    if (!inEnv) continue;
    const m = line.match(kv);
    if (!m) continue;
    const key = m[1]!;
    const val = m[2]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    if (key === 'CODEROVER_API_URL') out.apiUrl = val;
    else if (key === 'CODEROVER_API_TOKEN') out.token = val;
  }
  return out;
}
