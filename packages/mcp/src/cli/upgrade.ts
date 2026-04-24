/**
 * `coderover-mcp upgrade` — re-check backend + refresh every installed agent's
 * config in place. Useful after bumping `@coderover/mcp` to pick up tool name
 * map changes or new required env vars.
 *
 * Today the only thing that changes is the entry shape (`npx
 * @coderover/mcp@latest`). The command is wired so future version bumps can
 * ride the same hook with zero UX change.
 */

import type { AgentAdapter } from '../installer/types';
import { makeAdapter, AGENT_IDS } from '../installer/agents';
import { buildRemoteEntry } from '../installer/agents/base';
import { readEntryFromAgent, probeBackend } from './doctor';
import type { HttpClient } from '../transport/http-client';

export interface UpgradeOptions {
  apiUrl?: string;
  token?: string;
}

export interface UpgradeContext {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
  homeDir?: string;
  packageVersion: string;
  makeHttp?: (opts: { baseUrl: string; token?: string }) => HttpClient;
}

export async function runUpgrade(
  opts: UpgradeOptions,
  ctx: UpgradeContext,
): Promise<{ exitCode: number }> {
  ctx.out.write(
    `Refreshing installed configs for @coderover/mcp ${ctx.packageVersion}\n\n`,
  );

  const adapters: AgentAdapter[] = AGENT_IDS.map((id) =>
    makeAdapter(id, ctx.homeDir),
  );

  const installed: AgentAdapter[] = [];
  for (const a of adapters) {
    if (await a.hasMcpEntry()) installed.push(a);
  }

  if (installed.length === 0) {
    ctx.out.write(
      'No CodeRover entries found — nothing to upgrade. Run `install` first.\n',
    );
    return { exitCode: 0 };
  }

  let failed = 0;
  for (const a of installed) {
    const existing = await readEntryFromAgent(a);
    const apiUrl = opts.apiUrl ?? existing?.apiUrl ?? ctx.env.CODEROVER_API_URL;
    const token = opts.token ?? existing?.token ?? ctx.env.CODEROVER_API_TOKEN;
    if (!apiUrl || !token) {
      ctx.err.write(
        `  x ${a.name}: missing api-url or token; re-run install.\n`,
      );
      failed++;
      continue;
    }

    // Probe first so we don't rewrite on a dead backend. Non-fatal — we still
    // rewrite, but log the warning.
    if (ctx.makeHttp) {
      const probe = await probeBackend(ctx.makeHttp({ baseUrl: apiUrl, token }));
      if (!probe.ok) {
        ctx.err.write(
          `  warn ${a.name}: backend probe failed (${probe.reason}); continuing anyway.\n`,
        );
      }
    }

    try {
      await a.writeMcpEntry(
        buildRemoteEntry({
          apiUrl,
          token,
          packageVersion: ctx.packageVersion,
        }),
      );
      ctx.out.write(`  ok ${a.name}: refreshed ${a.configPath}\n`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      ctx.err.write(`  x ${a.name}: ${msg}\n`);
    }
  }

  return { exitCode: failed === 0 ? 0 : 1 };
}
