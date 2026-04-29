/**
 * Help + version output. Kept in its own file so it's cheap to include in
 * unit tests and easy to update without touching the dispatcher.
 */

import { AGENT_IDS } from '../installer/agents';

export function helpText(packageVersion: string): string {
  return `coderover-mcp ${packageVersion}
Model Context Protocol adapter for CodeRover.

USAGE
  coderover-mcp                        Run the MCP server on stdio (default).
  coderover-mcp install <agent>...     Register CodeRover with one or more MCP
                                       agents.
  coderover-mcp uninstall <agent>...   Remove CodeRover from each agent.
  coderover-mcp doctor [<agent>]       Check that each installed agent can
                                       reach the backend.
  coderover-mcp upgrade                Refresh configs after a version bump.
  coderover-mcp index [path]           Build the local SQLite index
                                       (incremental; skips unchanged files).
  coderover-mcp reindex [path]         Destroy and rebuild the local index
                                       from scratch.
  coderover-mcp watch [path]           Keep the local index live on file
                                       changes. Ctrl-C to stop.
  coderover-mcp list                   List local SQLite indices under
                                       ~/.coderover/ with project roots.
  coderover-mcp clean [flags]          Delete orphan or stale indices.
                                       Dry-run by default.

AGENTS
  ${AGENT_IDS.join(', ')}

INSTALL FLAGS
  --remote              Remote mode (default). Proxies to a CodeRover API.
  --local               Local mode. Self-contained SQLite + sqlite-vec index.
  --api-url <url>       CodeRover API URL. Falls back to CODEROVER_API_URL.
  --token <jwt>         MCP token. Falls back to CODEROVER_API_TOKEN or prompt.
  --embed <mode>        mock | openai | offline (local mode only).
  --db-path <path>      Override the local DB path (local mode only).
  --dry-run             Print the plan; write nothing.

INDEX / REINDEX / WATCH FLAGS
  --embed <mode>        mock | openai | offline. Default: openai.
  --verbose             Emit one line per indexed file / event.
  --debounce-ms <n>     (watch only) Per-path debounce. Default 500.

LIST FLAGS
  --json                Emit machine-readable JSON instead of a table.

CLEAN FLAGS
  --orphans             Target indices whose project root is gone.
  --unattributed        Target pre-0.2.2 indices that have no sidecar.
  --older-than <Nd>     Target indices last indexed > N days ago.
  --all                 Target every index. Requires --yes.
  -y, --yes             Actually delete. Default is dry-run.

GLOBAL FLAGS
  -h, --help            Show this message.
  -V, --version         Print the package version.
`;
}
