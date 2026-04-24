/**
 * `coderover-mcp uninstall <agent>...` — strip the coderover entry from each
 * agent's config, leaving every sibling key intact.
 */

import type { AgentAdapter, AgentId } from '../installer/types';
import { makeAdapter, isAgentId, AGENT_IDS } from '../installer/agents';

export interface UninstallOptions {
  agents: string[];
  dryRun: boolean;
}

export interface UninstallContext {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  homeDir?: string;
}

export async function runUninstall(
  opts: UninstallOptions,
  ctx: UninstallContext,
): Promise<{ exitCode: number }> {
  if (opts.agents.length === 0) {
    ctx.err.write('uninstall requires at least one <agent>.\n');
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

  let failed = 0;
  for (const a of adapters) {
    const had = await a.hasMcpEntry();
    if (!had) {
      ctx.out.write(`- ${a.name}: nothing to remove.\n`);
      continue;
    }
    if (opts.dryRun) {
      ctx.out.write(`[dry-run] would remove coderover from ${a.configPath}\n`);
      continue;
    }
    try {
      await a.removeMcpEntry();
      ctx.out.write(`✓ Removed CodeRover MCP from ${a.name}.\n`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      ctx.err.write(`✗ ${a.name}: ${msg}\n`);
    }
  }
  return { exitCode: failed === 0 ? 0 : 1 };
}
