# Changelog

## 0.5.0 — 2026-04-29

Closes the three deferred items from the 0.4.0 evaluation report
(B3 / B5 / B9). Adds a new companion package
[`@coderover/mcp-typescript`](https://www.npmjs.com/package/@coderover/mcp-typescript)
for proper TS grammar support.

### ⚠️ Behaviour change

- **`find_dependencies` dispatch heuristic changed** for bare-name
  targets. Pre-0.5.0, passing `lodash` to `find_dependencies` matched
  the imports table via an internal `pkg:` rewrite. 0.5.0 routes
  bare-name targets to symbol-grain by default (so
  `find_dependencies("verify")` returns the call sites of any function
  literally named `verify`). To recover the 0.4.x behaviour for bare
  module specifiers, pass the explicit `pkg:` form:
  `find_dependencies("pkg:lodash")`. Path-shaped (`/`, `\`, or known
  source extensions) and scoped-package (`@scope/name`) targets are
  unchanged.

### Added

- **B5 — Symbol-grain `find_dependencies`** (the 0.4.0 README's
  leading example finally works).
  - New `call_edges` table (migration 003) records every call site
    with `caller_qualified` / `callee_name` / `callee_qualified` /
    `src_file` / `call_line`. Indexes on the two callee columns and
    `src_file` keep upstream / downstream / reingest queries cheap.
  - JS/TS call extraction lands here. Walks every function / method /
    arrow body, recognises bare (`foo()`) and member (`obj.bar()`)
    callee shapes; top-level calls are deliberately skipped (agent
    noise). Caller attribution covers `function`, `class.method`,
    `class.constructor`, and arrow `const foo = () => ...`.
  - `find_dependencies` now dispatches on target shape (file path /
    bare module specifier → file-grain; qualified or bare symbol →
    symbol-grain). Response gains optional `targetKind: 'file' | 'symbol'`
    and per-entry `symbol` / `line` fields for symbol-grain edges.
  - Python / Go / Java call extractors are tracked for 0.5.1 — the
    pipeline already dispatches per language, those extractors just
    return `[]` today. JS/TS is the most common B5 query path.

- **B3 — Optional `tree-sitter-typescript` via the
  `@coderover/mcp-typescript` companion package.** The 0.4.0 eval
  flagged that `tree-sitter-javascript` chokes on TS-specific syntax
  (interfaces, type aliases, generics, return annotations end up
  under `hasError` nodes and the chunker drops them). 0.5.0 adds a
  graceful upgrade path:
  - Install `@coderover/mcp-typescript` and `@coderover/mcp` picks up
    the real TS grammar automatically — no flag, no env var.
  - Without the companion, behaviour is unchanged from 0.4.x: the JS
    grammar fallback runs and a one-line stderr warning fires once
    per process pointing at the install command.
  - Splitting the grammar into a companion follows the same pattern
    `@coderover/mcp-offline` introduced in 0.3.0 — keeps the default
    `@coderover/mcp` install lean (no 38 MB native grammar tax for
    pure-JS / Python / Go / Java users).
  - Loader exposes `isTypeScriptCompanionAvailable()` so `doctor` and
    integration tests can check the wiring without re-running the
    probe.

- **B9 — `coderover clean --unattributed`.** Reclaims disk from
  pre-0.2.2 indices that have no sidecar (listed as
  `(unknown — pre-0.2.2 index)`). `--orphans` deliberately can't
  touch them because we can't prove they're orphaned without a
  sidecar. The two flags are disjoint and OR-compose when both
  passed.

### Tests

- 5 new clean-cmd tests (B9): parser, selector disjointness, OR
  composition, end-to-end delete plan, refusal-hint update.
- 6 new call-extractor unit tests (B5, TS_REAL=1): function / class
  method / member call / top-level skip / arrow lexical_declaration /
  distinct edge_ids per line.
- 6 new `find_dependencies` tests (B5): symbol-grain upstream
  qualified + bare, symbol-grain downstream, classifyTarget routing
  branches.
- 3 new grammar-loader tests (B3): companion-absent fallback warning,
  companion-present grammar selection, fallback-warning de-dup.
- 0.4.x tests updated for the bare-module dispatch change and the new
  `targetKind` envelope field.

### Verification

```
npm run typecheck       exit 0
npm test                448 passed (was 433 + 15), 0 failed
npm run test:ts         all real-tree-sitter suites pass
npm run smoke:pack      packed tarball install + 4 boot checks pass
```

## 0.4.0 — 2026-04-24

Bugfix-driven minor. The headline correctness fixes change `tools/call`'s
behaviour for empty / missing arguments (now `isError: true` instead of
silent results), so this is a minor bump even though no APIs were renamed.

### ⚠️ Behaviour change

- **`tools/call` now rejects empty / missing required arguments** with
  `isError: true` and an `InvalidArgument:` prefix. Pre-0.4.0 the three
  local-mode tools fell through to SQL paths that, for empty input,
  returned spurious results stamped at confidence 1.0 — `find_symbol("")`
  returned the entire `symbols` table because `LIKE '' || '%'` matches
  everything; `find_dependencies("")` and `search_code("")` had the same
  shape problem. Agents that relied on those silent-match shapes will
  now see explicit errors and should retry with corrected input. The
  schemas (`required: ["query" | "symbolName" | "target"]`) already
  declared this contract; the server just wasn't enforcing it.

### Fixed

- **Local-mode pipeline now dispatches symbol + import extraction by
  language.** Wave 4 added `extractPythonSymbols` /
  `extractGoSymbols` / `extractJavaSymbols` (and the matching import
  extractors) but `pipeline.ts` kept calling the JS-only `extractSymbols`
  / `extractImports` for every language. Result: `payments.py` got a
  file-level chunk but zero symbol rows, so `find_symbol("PaymentProcessor")`
  returned empty even though the chunk existed. The pipeline now routes
  through `extractSymbolsForLanguage` / `extractImportsForLanguage`,
  closing the gap for Python / Go / Java. Regression test:
  `test/local/pipeline.spec.ts` — `dispatches symbol + import extraction
  by language`.

- **`serverInfo.version` and `LocalTransport.backendVersion` now read
  from `package.json`.** Both strings were hardcoded constants
  (`'0.1.0'` and `'0.2.0'` respectively) that drifted every publish; the
  initialize handshake reported `serverInfo.version: 0.1.0` from a 0.3.1
  install. New `src/version.ts` reads `package.json` once and caches the
  result, so both fields track the published version automatically. The
  `LocalTransport` capabilities test now asserts
  `${packageVersion}-local` instead of the literal `0.2.0` prefix.

### Added

- **`search_code` results carry `meta.embedder`** (`'openai'` |
  `'offline'` | `'mock'`) on the response payload so an agent can
  detect when semantic ranking is off — mock-mode embeddings are
  SHA-256-derived and have no meaning, but their per-result
  `confidence_score` previously looked indistinguishable from a real
  OpenAI score. The marker comes from a new optional `Embedder.modeLabel`
  field on the embedder interface; all three built-in implementations
  set it.

- **Regression tests for the three correctness fixes** under
  `test/transport/local-transport-live.spec.ts`: empty / missing /
  whitespace `symbolName`, `query`, and `target` all return
  `InvalidArgument`; `search_code` payload carries `meta.embedder`.

### Documentation

- **README quickstart rewritten to match the real response shape.** The
  pre-0.4.0 example showed `find_dependencies` returning
  `{ node_id, upstream: [{caller, file, confidence}] }` — fields that
  don't exist. The actual shape is `{ target, upstream: [{filePath,
  confidence, confidence_score}], downstream: [...] }` and is now
  documented as such. Also called out that `find_dependencies` is
  file-grain in 0.4.x; symbol-grain lands in 0.5.0.
- **New "Try it without an API key" snippet** showing the four-line path
  to a working install + index + `find_symbol` flow with `--embed mock`.
- **New "Local-mode language coverage" matrix** — explicitly documents
  the TypeScript gap: type annotations and TS-only declarations (`interface`,
  `type`) currently degrade because the local mode parses TS via the JS
  grammar. A `@coderover/mcp-typescript` companion package is on the
  roadmap to unlock the real grammar without bundling the ~38 MB
  `tree-sitter-typescript` dep into every install (same companion-package
  pattern that 0.3.0 used for offline embeddings).

### Known limitations (deferred to 0.5.0)

- **Symbol-grain `find_dependencies`.** Today `target` is matched
  verbatim against `imports.src_file` / `imports.target_path`. Symbol-
  grain traversal (`AuthService.verify` → individual call sites) is the
  next minor.
- **TypeScript symbol coverage gaps** — see the language-coverage matrix
  above. Tracked behind the `@coderover/mcp-typescript` companion-package
  proposal.

## 0.3.1 — 2026-04-22

### Added

- **Disk-backed catalog cache for remote mode** ([`CapabilitiesCache`](packages/mcp/src/transport/capabilities-cache.ts)).
  Successful `GET /mcp/capabilities` and `tools/list` responses are now
  persisted to `~/.coderover/remote-catalog-<sha>.json` keyed by the
  API URL. If a subsequent fetch fails (DNS blip, deploy rollover,
  laptop offline), the transport serves the cached catalog with a
  single-line stderr warning instead of crashing the MCP handshake.
  A fresh backend always overwrites the cache on success — stale
  entries are never preferred over live ones. Hard version mismatches
  (`CapabilityMismatchError`) deliberately skip the fallback so a blip
  during a backend downgrade can't pin a client to a pre-minimum
  version.
- **`coderover doctor` detects missing `@coderover/mcp-offline`** when
  an agent config has `CODEROVER_EMBED_MODE=offline`. Previously
  `offline` wasn't a recognized embed mode in the `embedder-reachable`
  check and fell through to "unknown embed mode" — and the 0.3.0
  split made that case reachable for the first time (users upgrading
  from 0.2.x who had offline mode set up before the companion package
  existed). Doctor now runs a resolution probe for
  `@xenova/transformers` and, on miss, suggests
  `npm install @coderover/mcp-offline` explicitly.

## 0.3.0 — 2026-04-22

### ⚠️ Breaking

- **Offline embed mode moved to a companion package.** `@xenova/transformers`
  is no longer an `optionalDependencies` of `@coderover/mcp`. Users who
  want `CODEROVER_EMBED_MODE=offline` must now install
  [`@coderover/mcp-offline`](https://www.npmjs.com/package/@coderover/mcp-offline):

  ```sh
  npm install @coderover/mcp-offline
  ```

  Nothing else changes — the CLI is identical, the env var is identical,
  the embedder implementation is identical. Only the install step is new.
  Remote-mode and openai-embed users need no action and benefit from a
  ~45 MB smaller install tree with zero criticals from this package's
  deps (previously: 5 CVEs via `protobufjs <7.5.5` → `onnx-proto` →
  `onnxruntime-web` → `@xenova/transformers`).

  The offline embedder's error message has been updated to point users
  at the new package.

## 0.2.2 — 2026-04-22

### Added

- **`coderover list`** — enumerate every local-mode SQLite index under
  `~/.coderover/` with its project root, size, and last-indexed time.
  Supports `--json` for machine-readable output. Pre-0.2.2 indices
  list as `(unknown — pre-0.2.2 index)` since they were written before
  the sidecar format existed.
- **`coderover clean`** — reclaim disk by deleting stale indices.
  Safe by default:
  - `--orphans` removes indices whose project root is gone.
  - `--older-than <Nd>` removes indices last indexed more than N days ago.
  - `--all` removes every index (requires `--yes`).
  - Dry-run by default; pass `--yes` to actually delete.
- **DB sidecar metadata** (`<sha>.meta.json` next to each `.db`) now
  written by `index` / `reindex` / `watch`. Records project root,
  first-indexed time, last-indexed time, and the package version that
  touched the DB last. `list` / `clean` read this to attribute each
  index to the project it came from.
- **Pre-publish packed-tarball smoke** (`scripts/prepublish-smoke.sh`,
  wired via `npm run smoke:pack` and `prepublishOnly`). Packs the
  tarball, installs it into a throwaway dir, and verifies `--version`,
  `--help` subcommand coverage, and the remote + local no-env error
  paths exit cleanly with code 2. Catches packaging regressions (dist
  gaps, `files` manifest typos, bin-shim breakage) that the in-tree
  test suite can't see.

### Fixed

- **Local mode boot broken in 0.2.0/0.2.1**: `npx @coderover/mcp` with
  `CODEROVER_MODE=local` (the entry shape the installer writes for
  `--local` installs) unconditionally entered remote-mode boot and
  exited 2 with `CODEROVER_API_URL is required`. `main()` now dispatches
  on `CODEROVER_MODE`, wires `LocalTransport` against the indexed
  SQLite DB at `CODEROVER_LOCAL_DB`, and surfaces a clear error if that
  env var is missing. Exports a new `resolveServerMode()` helper and
  re-exports `LocalTransport` for programmatic use.
- **Installer pinned `@latest` instead of the resolved version**. Every
  MCP host cold-start re-resolved `@coderover/mcp@latest` from the
  registry, slowing boots and exposing users to a bad publish. The
  `install` and `upgrade` commands now thread the running installer's
  version through `buildRemoteEntry` / `buildLocalEntry` and write an
  exact-pin `@coderover/mcp@<version>` into each agent config.
  Back-compat: callers that don't pass `packageVersion` still get
  `@latest` (matches pre-0.2.2 behavior).

### Added

- Subprocess smoke test that spawns `bin/coderover-mcp.js` in local
  mode against a seeded SQLite index and asserts `initialize` +
  `tools/list` return the three local tools. This is the regression
  guard that would have caught the 0.2.1 local-mode break pre-publish.

## 0.2.1 — 2026-04-22

### Fixed

- **Local mode indexing**: `coderover index` no longer aborts with
  `UNIQUE constraint failed on code_chunks_vec primary key` on files
  containing a single-line class (e.g. `class A { m() {} }`). The
  chunker emits separate chunks for a class and each of its methods;
  when the class fit on one line those chunks shared the
  `(filePath, lineStart, lineEnd)` tuple and collided on chunk ID.
  `computeChunkId` now also folds in `symbolKind` and `symbolName`,
  which matches the chunker's existing uniqueness contract. Whole-file
  fallback chunk IDs are unchanged.

## 0.2.0 — 2026-04-18

Phase 11 landed — **local mode**. `@coderover/mcp` now runs fully offline
against a SQLite + sqlite-vec index built from tree-sitter ASTs. Remote
mode is unchanged and remains the default.

### Added

- **Local mode** (`--local`): embedded backend. No backend API required.
  - `coderover index <path>` — build a SQLite index from the repo.
  - `coderover reindex <path>` — force a clean rebuild.
  - `coderover watch <path>` — live-reindex on file change via `@parcel/watcher`.
  - `coderover install <agent> --local` — writes `CODEROVER_MODE=local` config.
  - `coderover doctor` — auto-detects local mode and runs 8 local-specific checks (DB exists, schema, index non-empty, file-hash freshness, embedder reachable, sqlite-vec loadable).
- **Embedder options** via `CODEROVER_EMBED_MODE`:
  - `openai` (default) — `text-embedding-3-small` via OpenAI API, 1536-dim.
  - `offline` — `Xenova/all-MiniLM-L6-v2` via Transformers.js, 384-dim, fully offline after first model download (~30MB cached under `~/.coderover/models/`). Requires `@xenova/transformers` optionalDependency.
  - `mock` — deterministic SHA-256-derived vectors, zero network (dev/CI).
- **Language support** (previous JS/TS only):
  - Python: `class_definition`, `function_definition`, `async def`, `decorated_definition`. `import foo`, `from foo.bar import x`, relative imports (`.`, `..`).
  - Go: `function_declaration`, `method_declaration` with receiver types, `type_declaration` (struct/interface/type). `import_declaration` single + grouped.
  - Java: `class_declaration`, `interface_declaration`, `method_declaration`, `constructor_declaration`, `enum_declaration`. `import` (ignores `static`). `package_declaration` NOT treated as import.
- **Deterministic cross-mode identity**: local mode's `node_id` / `edge_id` computed via byte-identical SHA-256 hashing as the remote backend. A client can mix local and remote results safely.
- **Benchmarks**:
  - `npm run bench:index-10k` — 10k LOC indexed in <0.5s observed.
  - `npm run bench:query-p95` — search_code p95 ~2ms, find_symbol p95 ~0.1ms, find_dependencies p95 ~0.03ms.
  - `npm run bench:reingest` — 1-file reindex p95 ~4ms.
  - `npm run bench:recall` — recall@5 comparison across OpenAI / MiniLM / Mock (characterization, not a gate).

### Changed

- `code_chunks_vec` schema is now dim-aware via `makeSqliteVecMigration(dim)`. Default 1536 (backward compatible for existing DBs). Offline mode creates at 384. `openIndexedDb(path, expectedDim?)` throws a clear message on mismatch.
- `defaultDbPath` (installer) + `resolveDbPath` (CLI) unified on 16 hex chars of SHA-256 — installer config and runtime now agree on the DB file.

### New deps

- `better-sqlite3` ^11.7.0 — SQLite client.
- `sqlite-vec` 0.1.6 — vector search.
- `tree-sitter` ^0.21.1 + grammars: `tree-sitter-javascript` ^0.21.4, `tree-sitter-python` ^0.21.0, `tree-sitter-go` ^0.21.2, `tree-sitter-java` ^0.21.0.
- `@parcel/watcher` ^2.5.6 — filesystem events.
- `ignore` ^5.3.0 — gitignore matching.
- `@xenova/transformers` ^2.17.0 — **optional**. Only loaded when `CODEROVER_EMBED_MODE=offline`.

### Known limitations

- No back-pressure guard in watch daemon yet (Phase 10 C4-equivalent deferred).
- Embedder errors are fail-loud — a transient OpenAI outage rejects the whole `indexRepo` call. Retry the command.
- `tree-sitter` 0.21.x has process-wide state that flakes under jest's parallel workers. Real-parse specs are gated on `TS_REAL=1` and the `npm run test:ts` script runs each in its own process.
- Switching embed modes on an existing index requires `coderover reindex` (dim mismatch is detected and refused).

### Breaking changes

None. Remote mode is unchanged and the default.

## 0.1.0 — 2026-04-17

First public release of `@coderover/mcp` — the MCP server + installer for CodeRover.

### Features
- **MCP server** (`coderover` binary): stdio JSON-RPC server implementing `initialize`, `tools/list`, `tools/call`, `notifications/*`. Backed by the CodeRover graph-aware code search API.
- **Remote transport**: all tool calls proxy over HTTPS to the CodeRover backend. Signed with a JWT the user pastes during install. Minimum backend version gate (`minBackendVersion` in client config) refuses downgraded servers.
- **Tools exposed**:
  - `search_code` — semantic + lexical code search with confidence tags (EXTRACTED / INFERRED / AMBIGUOUS) and scores.
  - `find_symbol` — symbol resolution with deterministic node_ids.
  - `find_dependencies` — upstream + downstream graph traversal.
- **Install / uninstall / doctor / upgrade** subcommands that write per-client config:
  - `claude-code`: `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) and equivalents
  - `cursor`: `~/.cursor/mcp.json`
  - `aider`: `~/.aider.conf.yml`
  - `codex`: `~/.codex/config.toml`
  - `gemini-cli`: `~/.gemini-cli/config.json`
  - All writes are atomic (sibling `.tmp-coderover-{pid}-{ts}` + rename).
- **Scope-gated tokens**: server-side `@RequiresScope` guard enforces `citations:read` / `graph:read` / `search:read` per call.

### Known limitations
- Remote mode only. Local mode (embedded tree-sitter + SQLite + sqlite-vec) is tracked as A3b for a future release.
- Revocation cache TTL is 30 seconds; revoked tokens may still succeed for up to 30s after the ops team revokes them.

### Integration test coverage
- 24 end-to-end scenarios exercising auth handshake, initialize, tools/call, scope guard, token revocation — all pass against a real in-process backend. See `packages/mcp-integration/`.

### Breaking changes
N/A — first release.
