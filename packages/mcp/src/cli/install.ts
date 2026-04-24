/**
 * `coderover-mcp install <agent>...` — write the MCP entry for each agent.
 *
 * Flow:
 *   1. Validate agents.
 *   2. Resolve --api-url and --token (flags > env > prompt, if TTY).
 *   3. Sweep orphan .tmp-coderover-* files in parent dirs.
 *   4. For each adapter: write (or preview in --dry-run).
 *   5. Print success + first-prompt suggestion.
 *   6. Offer first-ingest trigger (best-effort).
 */

import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentAdapter, AgentId } from '../installer/types';
import { makeAdapter, isAgentId, AGENT_IDS } from '../installer/agents';
import { buildLocalEntry, buildRemoteEntry } from '../installer/agents/base';
import { sweepOrphans } from '../installer/atomic-write';
import { askLine, askYesNo, type PromptIo } from './prompt';
import type { HttpClient } from '../transport/http-client';

export interface InstallOptions {
  agents: string[];
  mode: 'remote' | 'local';
  apiUrl?: string;
  token?: string;
  /** Local-mode: override DB path (defaults to ~/.coderover/<sha>.db). */
  dbPath?: string;
  /** Local-mode: embedder selection.
   *  `openai` needs OPENAI_API_KEY.
   *  `offline` uses @xenova/transformers (MiniLM, ~30MB one-time download). */
  embedMode?: 'openai' | 'mock' | 'offline';
  dryRun: boolean;
}

export interface InstallContext {
  io: PromptIo;
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
  homeDir?: string;
  cwd: string;
  /** Injectable HTTP client for ingest streaming + doctor checks. */
  makeHttp?: (opts: { baseUrl: string; token?: string }) => HttpClient;
  /**
   * Pin the `npx @coderover/mcp@<version>` arg written into each agent
   * config. Defaults to `@latest` when omitted for back-compat with
   * callers that haven't been taught to pass it; production callers in
   * `runCli` always pass the resolved installer version so MCP hosts
   * don't re-resolve `@latest` on every cold start.
   */
  packageVersion?: string;
}

export interface InstallResult {
  exitCode: number;
}

/** First-prompt suggestion printed after a successful install. */
export const FIRST_PROMPT_SUGGESTION =
  'Walk me through how auth works in this repo.';

/**
 * Orchestrate an install.
 */
export async function runInstall(
  opts: InstallOptions,
  ctx: InstallContext,
): Promise<InstallResult> {
  if (opts.mode === 'local') {
    return runLocalInstall(opts, ctx);
  }

  if (opts.agents.length === 0) {
    ctx.err.write('install requires at least one <agent>.\n');
    ctx.err.write(`Supported: ${AGENT_IDS.join(', ')}\n`);
    return { exitCode: 1 };
  }

  // Validate every agent before we touch the filesystem.
  const adapters: AgentAdapter[] = [];
  for (const id of opts.agents) {
    if (!isAgentId(id)) {
      ctx.err.write(
        `unknown agent "${id}". Supported: ${AGENT_IDS.join(', ')}\n`,
      );
      return { exitCode: 1 };
    }
    adapters.push(makeAdapter(id as AgentId, ctx.homeDir));
  }

  // Resolve api-url + token.
  let apiUrl = opts.apiUrl ?? ctx.env.CODEROVER_API_URL ?? '';
  let token = opts.token ?? ctx.env.CODEROVER_API_TOKEN ?? '';

  if (!apiUrl) {
    if (!ctx.io.isTTY) {
      ctx.err.write(
        'missing --api-url; pass it or run in a TTY so we can prompt.\n',
      );
      return { exitCode: 1 };
    }
    apiUrl = await askLine(
      ctx.io,
      'CodeRover API URL (e.g. https://coderover.example.com): ',
    );
    if (!apiUrl) {
      ctx.err.write('aborting: empty API URL.\n');
      return { exitCode: 1 };
    }
  }

  if (!token) {
    if (!ctx.io.isTTY) {
      ctx.err.write(
        'missing --token; pass it or run in a TTY so we can prompt.\n',
      );
      return { exitCode: 1 };
    }
    const firstAgent = opts.agents[0]!;
    const mintUrl = buildTokenMintUrl(apiUrl, firstAgent);
    ctx.err.write(
      `Open this URL in a browser to mint an MCP token:\n  ${mintUrl}\n\n`,
    );
    token = await askLine(ctx.io, 'Paste the token here: ');
    if (!token) {
      ctx.err.write('aborting: empty token.\n');
      return { exitCode: 1 };
    }
  }

  const entry = buildRemoteEntry({
    apiUrl,
    token,
    packageVersion: ctx.packageVersion,
  });

  // Best-effort orphan sweep (one per unique config dir).
  const sweptDirs = new Set<string>();
  for (const a of adapters) {
    const dir = path.dirname(a.configPath);
    if (sweptDirs.has(dir)) continue;
    sweptDirs.add(dir);
    try {
      await sweepOrphans(dir);
    } catch {
      /* ignore */
    }
  }

  // Dry-run: just print the plan.
  if (opts.dryRun) {
    ctx.out.write('[dry-run] would write the following configs:\n');
    for (const a of adapters) {
      ctx.out.write(`  - ${a.name}: ${a.configPath}\n`);
    }
    ctx.out.write('[dry-run] entry:\n');
    ctx.out.write(`  ${JSON.stringify(entry)}\n`);
    return { exitCode: 0 };
  }

  const failed: string[] = [];
  for (const a of adapters) {
    try {
      await a.writeMcpEntry(entry);
      ctx.out.write(`✓ Installed CodeRover MCP for ${a.name}.\n`);
      ctx.out.write(`  Config: ${a.configPath}\n`);
    } catch (err) {
      failed.push(a.name);
      const msg = err instanceof Error ? err.message : String(err);
      ctx.err.write(`✗ ${a.name}: ${msg}\n`);
    }
  }

  if (failed.length > 0) {
    ctx.err.write(
      `\nInstall incomplete — ${failed.length}/${adapters.length} failed.\n`,
    );
    return { exitCode: 1 };
  }

  ctx.out.write('\nTry this in your agent:\n');
  ctx.out.write(`  "${FIRST_PROMPT_SUGGESTION}"\n`);

  // First-ingest prompt — best-effort, never fails the install.
  const wantIngest = await askYesNo(
    ctx.io,
    '\nTrigger first ingestion now?',
    true,
  );
  if (wantIngest && ctx.makeHttp) {
    await streamIngest({
      apiUrl,
      token,
      repoPath: ctx.cwd,
      out: ctx.out,
      err: ctx.err,
      makeHttp: ctx.makeHttp,
    });
  }

  return { exitCode: 0 };
}

/** Build the token-mint URL embedded in prompts. */
export function buildTokenMintUrl(apiUrl: string, agent: string): string {
  const base = apiUrl.replace(/\/+$/, '');
  const scope = encodeURIComponent('search:read,graph:read,citations:read');
  const label = encodeURIComponent(agent);
  return `${base}/auth/tokens/new?scope=${scope}&label=${label}`;
}

/** Stream NDJSON first-ingest progress. 404 → print hint, never fail. */
async function streamIngest(args: {
  apiUrl: string;
  token: string;
  repoPath: string;
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  makeHttp: NonNullable<InstallContext['makeHttp']>;
}): Promise<void> {
  const http = args.makeHttp({ baseUrl: args.apiUrl, token: args.token });
  let res: Awaited<ReturnType<HttpClient['request']>>;
  try {
    res = await http.request(
      'POST',
      `/ingest/stream?repo=${encodeURIComponent(args.repoPath)}`,
      {},
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    args.err.write(
      `  (ingest unreachable: ${msg}; trigger ingestion from the dashboard)\n`,
    );
    return;
  }

  if (res.status === 404) {
    args.out.write(
      '  (ingest endpoint not available — trigger ingestion from the dashboard)\n',
    );
    return;
  }
  if (!res.ok) {
    args.err.write(
      `  (ingest returned ${res.status}; trigger ingestion from the dashboard)\n`,
    );
    return;
  }

  // The HttpClient abstraction doesn't stream; fall back to one-shot text +
  // line-split. For real streaming we'd need a lower-level fetch — deferred.
  let text: string;
  try {
    text = await res.text();
  } catch {
    return;
  }
  const isTty = Boolean((args.out as { isTTY?: boolean }).isTTY);
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: { files?: number; symbols?: number; eta_sec?: number } | null =
      null;
    try {
      parsed = JSON.parse(line);
    } catch {
      /* not ndjson */
    }
    if (parsed) {
      const msg = `[ingest] ${parsed.files ?? '?'} files / ${parsed.symbols ?? '?'} symbols / ${parsed.eta_sec ?? '?'}s remaining`;
      if (isTty) {
        args.out.write(`\r${msg}`);
      } else {
        args.out.write(msg + '\n');
      }
    }
  }
  if (isTty) args.out.write('\n');
}

/**
 * Deterministic default DB path for a given project root.
 *
 * We hash the absolute project root with sha256 and take the first 12 hex
 * chars. That's cross-process-stable (the same repo always resolves to the
 * same file) yet prefix-collision-safe enough for the ~few dozen indices
 * we'd ever see on a single machine.
 */
export function defaultDbPath(projectRoot: string, homeDir?: string): string {
  // Must match `src/cli/local/shared.ts::resolveDbPath` byte-for-byte —
  // installer config points at the SAME file the index/watch commands open.
  // 16 hex chars (not 12) — reconciled to the canonical shared helper.
  const home = homeDir ?? os.homedir();
  const hash = crypto
    .createHash('sha256')
    .update(path.resolve(projectRoot))
    .digest('hex')
    .slice(0, 16);
  return path.join(home, '.coderover', `${hash}.db`);
}

/**
 * Local-mode install: write a `CODEROVER_MODE=local` entry per agent.
 *
 * Skips the remote API URL + token prompts. Still picks an embed mode (
 * default `openai`) and warns if the corresponding key isn't present.
 */
async function runLocalInstall(
  opts: InstallOptions,
  ctx: InstallContext,
): Promise<InstallResult> {
  if (opts.agents.length === 0) {
    ctx.err.write('install requires at least one <agent>.\n');
    ctx.err.write(`Supported: ${AGENT_IDS.join(', ')}\n`);
    return { exitCode: 1 };
  }

  const adapters: AgentAdapter[] = [];
  for (const id of opts.agents) {
    if (!isAgentId(id)) {
      ctx.err.write(
        `unknown agent "${id}". Supported: ${AGENT_IDS.join(', ')}\n`,
      );
      return { exitCode: 1 };
    }
    adapters.push(makeAdapter(id as AgentId, ctx.homeDir));
  }

  const projectRoot = ctx.cwd;
  const dbPath = opts.dbPath ?? defaultDbPath(projectRoot, ctx.homeDir);

  // Resolve embed mode: flag > env-derived default > prompt (TTY only) > openai.
  let embedMode: 'openai' | 'mock' | 'offline' = opts.embedMode ?? 'openai';
  if (!opts.embedMode && ctx.io.isTTY) {
    const raw = (
      await askLine(
        ctx.io,
        'Embedder [openai/offline/mock] (default openai): ',
      )
    )
      .trim()
      .toLowerCase();
    if (raw === 'mock') embedMode = 'mock';
    else if (raw === 'offline') embedMode = 'offline';
    else if (raw === '' || raw === 'openai') embedMode = 'openai';
    else {
      ctx.err.write(`aborting: unknown embed mode "${raw}".\n`);
      return { exitCode: 1 };
    }
  }

  if (embedMode === 'openai' && !ctx.env.OPENAI_API_KEY) {
    ctx.err.write(
      'warning: --embed openai but OPENAI_API_KEY is not set. ' +
        'Set it before running `coderover index`, or re-install with --embed mock.\n',
    );
  }

  const entry = buildLocalEntry({
    dbPath,
    embedMode,
    packageVersion: ctx.packageVersion,
  });

  // Sweep orphans once per unique config dir, same as remote flow.
  const sweptDirs = new Set<string>();
  for (const a of adapters) {
    const dir = path.dirname(a.configPath);
    if (sweptDirs.has(dir)) continue;
    sweptDirs.add(dir);
    try {
      await sweepOrphans(dir);
    } catch {
      /* ignore */
    }
  }

  if (opts.dryRun) {
    ctx.out.write('[dry-run] would write the following local-mode configs:\n');
    for (const a of adapters) {
      ctx.out.write(`  - ${a.name}: ${a.configPath}\n`);
    }
    ctx.out.write(`[dry-run] DB path: ${dbPath}\n`);
    ctx.out.write(`[dry-run] embed mode: ${embedMode}\n`);
    ctx.out.write('[dry-run] entry:\n');
    ctx.out.write(`  ${JSON.stringify(entry)}\n`);
    return { exitCode: 0 };
  }

  const failed: string[] = [];
  for (const a of adapters) {
    try {
      await a.writeMcpEntry(entry);
      ctx.out.write(`✓ Installed CodeRover MCP (local) for ${a.name}.\n`);
      ctx.out.write(`  Config: ${a.configPath}\n`);
    } catch (err) {
      failed.push(a.name);
      const msg = err instanceof Error ? err.message : String(err);
      ctx.err.write(`✗ ${a.name}: ${msg}\n`);
    }
  }

  if (failed.length > 0) {
    ctx.err.write(
      `\nInstall incomplete — ${failed.length}/${adapters.length} failed.\n`,
    );
    return { exitCode: 1 };
  }

  ctx.out.write('\nNext steps:\n');
  ctx.out.write(
    `  1. Index this repo:  npx @coderover/mcp index ${projectRoot}\n`,
  );
  ctx.out.write(
    '  2. Optional watch:   npx @coderover/mcp watch\n',
  );
  ctx.out.write(`  3. Try this prompt:  "${FIRST_PROMPT_SUGGESTION}"\n`);
  return { exitCode: 0 };
}

/** Read config file, checking it actually parses. Useful for smoke tests. */
export async function readConfigOrEmpty(p: string): Promise<string> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return '';
  }
}
