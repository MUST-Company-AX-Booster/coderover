# @coderover/mcp

MCP server and installer for [CodeRover](https://github.com/MUST-Company-AX-Booster/coderover) graph-aware code search.

Plug your MCP-compatible agent (Claude Code, Cursor, Aider, Codex, Gemini CLI) into CodeRover and get real semantic + graph-aware answers about your codebase — not just grep over open files. The server speaks JSON-RPC over stdio to the agent and answers tool calls via either:

- **Remote mode** (default): proxies to a running CodeRover API over HTTPS. Secrets stay on your machine, code never leaves your VPC.
- **Local mode** (v0.2.0+): a self-contained SQLite + sqlite-vec index built from tree-sitter ASTs on your local filesystem. No backend required.

## Install — remote mode

Point the installer at your client. It prompts for your CodeRover API URL and a scoped token, then patches the client's config atomically.

```sh
npx @coderover/mcp@latest install claude-code
npx @coderover/mcp@latest install cursor
npx @coderover/mcp@latest install aider
npx @coderover/mcp@latest install codex
npx @coderover/mcp@latest install gemini-cli
```

## Install — local mode (v0.2.0+)

For a zero-backend setup: add `--local`, then build an index of your repo.

```sh
# 1. Install for your agent with --local
npx @coderover/mcp@latest install claude-code --local

# 2. Build the index (~0.5s per 10k LOC)
npx @coderover/mcp@latest index ./my-repo

# 3. Optional: keep it live while you work
npx @coderover/mcp@latest watch ./my-repo
```

The installer writes `CODEROVER_MODE=local` + `CODEROVER_LOCAL_DB=~/.coderover/<sha>.db` to the agent's config. Supports JavaScript, TypeScript, Python, Go, and Java.

Embedder options via `CODEROVER_EMBED_MODE`:

| Mode     | Dimension | Model                            | Network | Install cost                                            |
| -------- | --------- | -------------------------------- | ------- | ------------------------------------------------------- |
| `openai` | 1536      | `text-embedding-3-small`         | Yes     | `OPENAI_API_KEY` required. ~$2 to index 100k LOC once.  |
| `offline`| 384       | `Xenova/all-MiniLM-L6-v2` (Transformers.js) | No (after first model download) | `npm install @coderover/mcp-offline` (companion package, ~45 MB including the ONNX runtime). |
| `mock`   | 1536      | SHA-256-derived deterministic    | No      | None. Dev / CI. No semantic signal.                      |

Default is `openai`. Switch via `--embed offline` at install time, or `CODEROVER_EMBED_MODE=offline npx @coderover/mcp@latest index ./my-repo`.

### Offline mode uses a companion package

As of 0.3.0, `@xenova/transformers` is **not** bundled with `@coderover/mcp` — the ONNX runtime it pulls in (~45 MB of wasm + a transitive `protobufjs` chain with 5 critical CVEs) was unwanted weight on every install. Users who actually want offline mode install [`@coderover/mcp-offline`](https://www.npmjs.com/package/@coderover/mcp-offline):

```sh
npm install @coderover/mcp-offline
```

That one install pulls in both `@coderover/mcp` and the Transformers.js runtime. If you try `--embed offline` without the companion package, the error message points you here. `coderover doctor` also detects missing companion packages for configs with `CODEROVER_EMBED_MODE=offline` and surfaces the fix.

During install you'll see:

```
? CodeRover API URL:   https://coderover.acme.internal
? Paste your API token: ••••••••••••••••
✓ verified backend v0.9.1 (>= required v0.9.0)
✓ wrote ~/Library/Application Support/Claude/claude_desktop_config.json
✓ restart Claude Code to pick up the new server
```

The token is written verbatim into the client's config file (never sent anywhere else). Get one from your CodeRover admin UI under **Settings → MCP tokens**.

## Quickstart

After install, restart your agent and try:

> **"what files import `src/auth/auth.service.ts`?"**

The agent calls `find_dependencies` and streams back the importers and the targets it imports:

```json
{
  "target": "src/auth/auth.service.ts",
  "upstream": [
    { "filePath": "src/auth/auth.controller.ts", "confidence": "EXTRACTED", "confidence_score": 1 },
    { "filePath": "src/middleware/require-auth.ts", "confidence": "EXTRACTED", "confidence_score": 1 }
  ],
  "downstream": [
    { "filePath": "pkg:bcrypt",      "confidence": "EXTRACTED", "confidence_score": 1 },
    { "filePath": "src/db/users.ts", "confidence": "EXTRACTED", "confidence_score": 1 }
  ]
}
```

Other prompts worth trying:

- **"semantic search: functions that retry on 429"** — `search_code` returns hits stamped `confidence: EXTRACTED` with a numeric `confidence_score`. The result envelope also carries `meta.embedder` (`openai`/`offline`/`mock`) so an agent can downweight `mock` hits — those have no semantic signal by design.
- **"find the symbol `PaymentProcessor`"** — `find_symbol` returns one row per match with `node_id`, `filePath`, and the line span. The qualified-name LIKE-match also surfaces `PaymentProcessor.charge`, `PaymentProcessor.refund`, etc.
- **"who calls `AuthService.verify`?"** — `find_dependencies` is now **file-grain or symbol-grain** (0.5.0+). Pass a repo-relative path (`src/auth/auth.service.ts`) for file-grain edges via the imports table, or a qualified symbol (`AuthService.verify`) for call-site edges via the new `call_edges` table. The response includes `targetKind: 'file' | 'symbol'` plus per-entry `symbol` and `line` fields for symbol-grain hits. Symbol-grain call extraction is JS/TS-only in 0.5.0; Python/Go/Java land in 0.5.1.
- **"what does `src/auth/auth.service.ts` import?"** — pass the file path; you get the upstream importers and downstream imports as before.

### Try it without an API key

For a 60-second smoke test of the full flow — no OpenAI key, no companion package:

```sh
# 1. Install in local mode with the deterministic mock embedder.
npx @coderover/mcp@latest install claude-code --local --embed mock

# 2. Index any repo. Vectors are deterministic SHA-256 derivations —
#    enough to verify the plumbing end-to-end, not enough for real ranking.
CODEROVER_EMBED_MODE=mock npx @coderover/mcp@latest index ./my-repo

# 3. Restart the agent and try `find_symbol PaymentProcessor` —
#    works against any indexed JS, TS, Python, Go, or Java file.
```

Mock-mode `search_code` results carry `meta.embedder: "mock"` so the agent can detect that semantic ranking is off. Switch to `--embed openai` (and set `OPENAI_API_KEY`) when you want real similarity.

## Config reference

The server reads two environment variables. The installer writes these into your agent's config; you rarely need to touch them by hand.

### Remote mode

| Variable              | Required | Description                                                           |
| --------------------- | -------- | --------------------------------------------------------------------- |
| `CODEROVER_API_URL`   | Yes      | Base URL of your CodeRover API, e.g. `https://coderover.acme.internal`. |
| `CODEROVER_API_TOKEN` | Yes      | JWT with at least `search:read`. Issued by the CodeRover admin UI.    |

### Local mode

| Variable                | Required | Description                                                                 |
| ----------------------- | -------- | --------------------------------------------------------------------------- |
| `CODEROVER_MODE`        | Yes      | Set to `local`. Installer writes this when invoked with `--local`.          |
| `CODEROVER_LOCAL_DB`    | Yes      | Absolute path to the SQLite index file. Default `~/.coderover/<sha>.db`.    |
| `CODEROVER_EMBED_MODE`  | No       | `openai` (default) / `offline` / `mock`. See table above.                   |
| `OPENAI_API_KEY`        | Only for openai | Used to embed both chunks (at index time) and queries (at search time). |

All diagnostic output goes to stderr with a `[coderover-mcp]` prefix. stdout is reserved for JSON-RPC frames — safe to pipe anywhere.

## Supported clients

| Agent         | Config file written                                                |
| ------------- | ------------------------------------------------------------------ |
| `claude-code` | `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac); platform-equivalent paths on Linux and Windows |
| `cursor`      | `~/.cursor/mcp.json`                                               |
| `aider`       | `~/.aider.conf.yml`                                                |
| `codex`       | `~/.codex/config.toml`                                             |
| `gemini-cli`  | `~/.gemini-cli/config.json`                                        |

All writes are atomic — the installer writes to `<target>.tmp-coderover-<pid>-<ts>` and renames, so a crash mid-write can't corrupt your existing config.

## Managing local indices

Local-mode indices live under `~/.coderover/<sha>.db` (keyed by project root). Two commands help you see what's there and reclaim disk:

```sh
# Enumerate every index with its project root, size, and last-indexed time
npx @coderover/mcp@latest list
npx @coderover/mcp@latest list --json   # machine-readable

# Reclaim disk. Safe by default — refuses to run without a filter, previews
# as a dry-run unless --yes.
npx @coderover/mcp@latest clean --orphans                  # project root gone
npx @coderover/mcp@latest clean --older-than 30d           # stale indices
npx @coderover/mcp@latest clean --orphans --yes            # actually delete
```

Indices written by 0.2.x (pre-sidecar) list as `(unknown — pre-0.2.2 index)` and are never touched by `clean --orphans` — only indices with a known, now-nonexistent `projectRoot` count as orphans. To reclaim disk from those, pass `--unattributed` (0.5.0+):

```sh
npx @coderover/mcp@latest clean --unattributed --yes      # delete every pre-0.2.2 index
npx @coderover/mcp@latest clean --orphans --unattributed  # both, OR-composed; dry-run
```

## Local-mode language coverage

| Language    | Chunks | Symbols | Imports | Notes |
| ----------- | ------ | ------- | ------- | ----- |
| JavaScript  | ✅     | ✅      | ✅      | Full coverage. Both CommonJS (`require`) and ESM (`import`) imports are extracted, plus dynamic `import()`. |
| TypeScript  | ✅†    | ✅†     | ✅      | Full coverage when [`@coderover/mcp-typescript`](https://www.npmjs.com/package/@coderover/mcp-typescript) is installed (the real TS grammar — interfaces, type aliases, generics, decorators, return annotations all parse cleanly). Without the companion, the JS-grammar fallback runs and TS-only constructs degrade exactly as in 0.4.x. † indicates the companion-installed path. |
| Python      | ✅     | ✅      | ✅      | Classes, methods (`Class.method` qualified), top-level functions, decorated definitions, `import`, `from … import`, and relative imports (`from .sib import x`). |
| Go          | ✅     | ✅      | ✅      | Functions, methods (`Type.method` qualified), `type` declarations (struct / interface / alias). Imports always emitted as `pkg:` (Go has no in-repo path resolution). |
| Java        | ✅     | ✅      | ✅      | Classes, interfaces, enums, methods, constructors, records (treated as classes). Imports include `static` and wildcard forms. |

`find_dependencies` is **file-grain or symbol-grain in 0.5.0+**: pass a repo-relative path (`src/auth/auth.service.ts`) for the imports edges, or a qualified symbol (`AuthService.verify`) for the call-site edges. The response includes a `targetKind: 'file' | 'symbol'` marker. Symbol-grain call extraction is JS/TS-only in 0.5.0; Python/Go/Java land in 0.5.1.

### Companion packages

`@coderover/mcp` keeps its install lean by splitting heavy optional deps into companion packages:

| Companion                                                                                            | Adds                                                                       | Install cost                            |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------- |
| [`@coderover/mcp-offline`](https://www.npmjs.com/package/@coderover/mcp-offline) (0.3.0+)            | Offline embeddings via `Xenova/all-MiniLM-L6-v2` (Transformers.js, 384-dim) | ~45 MB (ONNX runtime + grammar weights) |
| [`@coderover/mcp-typescript`](https://www.npmjs.com/package/@coderover/mcp-typescript) (0.5.0+)      | Real `tree-sitter-typescript` grammar (interfaces, type aliases, generics, decorators) | ~38 MB (precompiled native parser per platform) |

Install the one you need; `@coderover/mcp` probes for each at boot and uses it automatically when present.

## Resilience: catalog cache (remote mode)

Successful `GET /mcp/capabilities` and `tools/list` responses from the CodeRover API are persisted to `~/.coderover/remote-catalog-<sha>.json`. If a later fetch fails (DNS blip, deploy rollover, laptop offline), the transport serves the cached catalog with a one-line stderr warning instead of crashing the MCP handshake — your agent keeps working against the last-known tools until the backend comes back.

Fresh live responses always overwrite the cache, so stale entries are never served when the live call succeeds. Hard version mismatches (`CapabilityMismatchError`) deliberately skip the fallback so a blip during a backend downgrade can't silently pin a client to a pre-minimum version.

## Uninstall

```sh
# Remove the CodeRover entry from one client
npx @coderover/mcp@latest uninstall claude-code

# Verify nothing's left behind
npx @coderover/mcp@latest doctor claude-code
```

`doctor` auto-detects whether your config is remote or local and runs mode-appropriate checks:

- **Remote**: config file parseable, API reachable, token valid, backend version acceptable.
- **Local**: DB exists, schema current, index non-empty, file hashes match disk, embedder reachable (`openai` needs `OPENAI_API_KEY`, `offline` needs `@coderover/mcp-offline` installed, `mock` needs nothing), sqlite-vec binary loadable.

## Upgrade

```sh
npx @coderover/mcp@latest upgrade
```

Checks the npm registry for a newer `@coderover/mcp` and checks the configured CodeRover API's `minRequiredVersion` field. Prints the single command to run if you're behind on either side.

## Support

Issues, feature requests, and questions: [github.com/MUST-Company-AX-Booster/coderover/issues](https://github.com/MUST-Company-AX-Booster/coderover/issues).
