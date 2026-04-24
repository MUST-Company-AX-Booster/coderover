# Graph Intelligence & Code-Graph-RAG (Plan + Current Implementation)

This document serves two purposes:

1. **Working documentation for the current Graph Intelligence implementation (Phase 7).**
2. **Forward-looking plan** for expanding to an entity-level Code-Graph-RAG (Memgraph + multi-language parsing).

## 1. Executive Summary

CodeRover Phase 7 provides code-graph capabilities built from ingestion metadata:

- **File-level dependency graph** computed on-demand from `code_chunks.imports` stored in Postgres.
- **Impact analysis** (reverse dependency traversal).
- **Circular dependency detection** (DFS-based cycle detection).
- **Architectural hotspots** (in-degree ranking).
- **Optional graph sync to Memgraph** (File/Symbol nodes + IMPORTS/DEFINES edges) to enable faster traversal and NL graph queries via MCP.

The Code-Graph-RAG expansion upgrades this to an **entity-level knowledge graph** (Functions, Classes, CALLS, INHERITS, DEFINES, IMPORTS) stored in Memgraph, enabling deeper reasoning and faster queries.

## 2. Module Topology (What Depends On What)

### 2.1 NestJS Modules

- `src/graph/graph.module.ts`
  - Provides: `GraphService`, `MemgraphService`
  - Imports: `DatabaseModule` (for TypeORM `DataSource`)
  - Exports: `GraphService`, `MemgraphService`

GraphModule is consumed by:

- `src/app.module.ts` (top-level registration)
- `src/ingest/ingest.module.ts` (ingestion calls graph sync)
- `src/mcp/mcp.module.ts` (MCP tools call GraphService and MemgraphService)
- `src/repo/repo.module.ts` (repo cleanup clears Memgraph graph data)

### 2.2 Runtime Data Sources

The graph features pull data from:

- **Postgres** (source of truth for indexed structure)
  - `code_chunks.imports` (JSONB)
  - `code_chunks.symbols` (JSONB)
  - `code_chunks.nest_role`, `code_chunks.module_name`
- **Memgraph** (secondary index / accelerator, populated by `syncRepoToMemgraph`)
  - File nodes and Symbol nodes
  - IMPORTS and DEFINES edges

## 3. Public API (REST)

All graph endpoints are JWT-protected via `JwtAuthGuard`.

Base route: `/graph/*` from `src/graph/graph.controller.ts`.

### 3.1 `GET /graph/dependencies`

Query params:

- `repoId` (required) — repository UUID

Response: `GraphData`

```ts
{
  nodes: Record<string, {
    filePath: string;
    moduleName: string | null;
    nestRole: string | null;
    imports: Array<{ source: string; names: string[]; isRelative: boolean }>;
    dependencies: string[];
    inDegree: number;
  }>;
  edges: Array<{ source: string; target: string }>;
  cycles: Array<{ chain: string[] }>;
  hotspots: Array<{ filePath: string; moduleName: string | null; inDegree: number }>;
}
```

Notes:

- Nodes are keyed by `filePath`.
- `cycles` and `hotspots` are computed during the same build.

### 3.2 `GET /graph/impact`

Query params:

- `repoId` (required)
- `filePath` (required) — target file path (exact match against graph node keys)

Response:

```ts
{
  target: string;
  impactCount: number;
  impactList: string[];
}
```

Semantics: returns all files that (directly or transitively) import the target file.

### 3.3 `GET /graph/cycles`

Query params:

- `repoId` (required)

Response:

```ts
{
  cyclesCount: number;
  cycles: Array<{ chain: string[] }>;
}
```

Semantics: each `chain` ends with the start node repeated to close the loop.

### 3.4 `GET /graph/hotspots`

Query params:

- `repoId` (required)

Response:

```ts
{
  hotspots: Array<{ filePath: string; moduleName: string | null; inDegree: number }>;
}
```

Semantics: Top 20 files by in-degree (number of importing files).

## 4. Backend Implementation Details

### 4.1 `GraphService` (Postgres → In-memory Graph)

Primary file: `src/graph/graph.service.ts`.

#### 4.1.1 `buildGraph(repoId)`

Data fetch:

- Reads Postgres:
  - `SELECT DISTINCT ON (file_path) file_path, module_name, nest_role, imports FROM code_chunks WHERE repo_id = $1 AND imports IS NOT NULL`

Graph construction:

- Initializes `nodes` from the query result.
- Resolves each `ImportInfo.source` to a target file path via `resolveImportPath()`.
- Creates edges: `{ source: importerFile, target: resolvedImportedFile }`.
- Updates `inDegree` on each imported target node.

Important behavior:

- Files without `imports` are not returned by the SQL filter (`imports IS NOT NULL`) and may not appear as nodes.
- Imports resolve only if a matching target exists in `allFiles` (the node set).

#### 4.1.2 `analyzeImpact(repoId, filePath)`

- Rebuilds the graph on-demand.
- Builds a reverse adjacency list from `graph.edges`.
- Runs BFS from the target file to collect all reverse dependents.
- Returns unique file paths (excluding the target itself).

#### 4.1.3 `detectCycles(nodes)`

- Standard DFS with recursion stack detection.
- When a back-edge is found, constructs a cycle chain from the path stack.
- Deduplicates cycles by sorting node sets (dedupe favors "cycle membership", not exact order).

#### 4.1.4 `calculateHotspots(nodes)`

- Uses `inDegree` (number of incoming edges).
- Returns top 20 files with `inDegree > 0`.

#### 4.1.5 `resolveImportPath(currentPath, importSource, allFiles)`

Resolution rules:

- Strips common extensions from the import source (`.ts`, `.tsx`, `.js`, `.py`, `.go`, `.java`, `.kt`, `.php`, `.rs`).
- Relative imports (`./` or `../`):
  - Resolves against `path.dirname(currentPath)`.
  - Checks common variants (extension + `index` file patterns).
- Non-relative imports:
  - Handles `@/` and `~/` by stripping prefix.
  - Converts dot-notation imports to path segments when no `/` present (useful for Python/Java-style `a.b.c`).
  - Matches by suffix against known file paths.

### 4.2 Postgres Structural Metadata (Where `imports`/`symbols` Come From)

#### 4.2.1 TypeScript parsing

- `src/ingest/ast.service.ts` parses `.ts`/`.tsx` using `@typescript-eslint/typescript-estree`.
- Outputs:
  - `symbols`: top-level class/function/interface/enum/type/const with line ranges
  - `imports`: import declarations with `{ source, names, isRelative }`
  - `exports`: exported symbol names
  - `nestRole`: derived from decorators and path heuristics

#### 4.2.2 Multi-language parsing

- `src/ingest/languages/multi-lang-ast.service.ts` parses: Python, Go, Java, Kotlin, Rust, PHP, JavaScript, Vue SFC.
- Uses `tree-sitter` grammars; extracts symbols and (where available) imports.

#### 4.2.3 Storage

- `src/ingest/embedder.service.ts` upserts into `code_chunks` and persists:
  - `symbols` (JSONB)
  - `imports` (JSONB)
  - `nest_role` (TEXT)
  - `exports` (JSONB)
  - `language`, `framework`

Relevant migrations:

- `src/database/migrations/001_initial_schema.ts`: creates `code_chunks` (+ pgvector)
- `src/database/migrations/003_structural_metadata.ts`: adds `symbols`, `imports`, `nest_role`, `exports`
- `src/database/migrations/005_hybrid_search.ts`: adds `language`, `framework`, `artifact_type`, `chunk_tsv`

## 5. Memgraph Integration (Secondary Graph Store)

### 5.1 Infrastructure

- Docker service is defined in `docker-compose.yml` as `memgraph`, exposing:
  - `7687` (Bolt)
  - `7444` (Memgraph Lab)

### 5.2 Connection & Environment

- `src/graph/memgraph.service.ts` connects using `neo4j-driver` (Bolt).
- Env var:
  - `MEMGRAPH_URI` (default: `bolt://localhost:7687`)

If the API runs in Docker, set:

- `MEMGRAPH_URI=bolt://memgraph:7687`

### 5.3 Schema (Current)

`MemgraphService.initializeSchema()` creates indexes:

- `:File(repoId, filePath)`
- `:Function(repoId, filePath, name)` (reserved for future)
- `:Class(repoId, filePath, name)` (reserved for future)

Current node/edge types used:

- Nodes:
  - `(:File {repoId, filePath, moduleName, nestRole})`
  - `(:Symbol {repoId, name, kind, filePath})`
- Edges:
  - `(:File)-[:IMPORTS]->(:File)`
  - `(:File)-[:DEFINES]->(:Symbol)`

### 5.4 Sync Flow (Postgres → Memgraph)

- `GraphService.syncRepoToMemgraph(repoId)`:
  1. Calls `buildGraph(repoId)` to compute file-level nodes/edges.
  2. Loads `{ file_path, symbols }` from Postgres.
  3. Clears existing Memgraph nodes for `repoId`.
  4. Inserts `File` nodes.
  5. Inserts `Symbol` nodes and `DEFINES` relationships.
  6. Inserts `IMPORTS` edges between `File` nodes.

Triggered during ingestion:

- `src/ingest/ingest.service.ts` calls `graphService.syncRepoToMemgraph(repoId)` after chunk upsert.

Cleanup behavior:

- `src/repo/repo.service.ts` clears graph data via `memgraphService.clearRepoData(repoId)` when deleting/deactivating repos.

## 6. MCP Tooling (Graph)

All MCP tools are registered in `src/mcp/mcp.module.ts`.

### 6.1 `graph_analysis` (Postgres-backed)

- Implementation: `src/mcp/tools/graph-analysis.tool.ts`
- Parameters:
  - `repoId` (required)
  - `analysisType`: `tree | cycles | impact | hotspots`
  - `filePath` (required for `impact`)
- Uses `GraphService.buildGraph()` and `GraphService.analyzeImpact()`.

### 6.2 `query_code_graph` (Memgraph-backed)

- Implementation: `src/mcp/tools/query-code-graph.tool.ts`
- Parameters:
  - `repoId` (required)
  - `query` (required) — natural language prompt

Behavior:

1. Uses an LLM to generate a Cypher query based on the known schema (File/Symbol + IMPORTS/DEFINES).
2. Executes Cypher against Memgraph and returns formatted records.

Important notes:

- The current schema does not contain `CALLS`/`INHERITS`, only file imports and symbol definitions.
- The model name is currently hardcoded in the tool implementation; this should align with the configured provider/model strategy in the rest of the system.

## 7. Frontend (Graph Intelligence UI)

Primary page: `coderover-frontend/src/pages/GraphPage.tsx`.

### 7.1 Data Fetching

Uses `coderover-frontend/src/lib/api/graph.ts` to call:

- `/graph/dependencies?repoId=...`
- `/graph/cycles?repoId=...`
- `/graph/hotspots?repoId=...`
- `/graph/impact?repoId=...&filePath=...`

Also calls MCP REST wrapper:

- `POST /mcp/execute` with tool `query_code_graph` for natural language graph queries.

### 7.2 Visualization

- Uses `@xyflow/react` to render a directed graph.
- Uses `dagre` to compute layout (top-to-bottom by default).
- Nodes are file paths (label = basename).
- Edges are file-level import edges.

## 8. Libraries & Dependencies (Graph-Related)

### 8.1 Backend (coderover-api)

- `neo4j-driver`: Bolt driver used to talk to Memgraph.
- `typeorm`: Postgres access via `DataSource` and repositories.
- `@nestjs/swagger`: Graph endpoints are tagged as “Graph Intelligence”.
- `@typescript-eslint/typescript-estree`: TS/TSX structural extraction (symbols/imports).
- `tree-sitter` + language grammars: multi-language parsing (symbols/imports).

### 8.2 Frontend (coderover-frontend)

- `@xyflow/react`: graph rendering
- `dagre`: automatic DAG layout

## 9. Code-Graph-RAG Expansion Plan (Entity-Level)

### 9.1 Goal

Upgrade from file-level graphs to an entity graph:

- Nodes: `File`, `Function`, `Class`, `Module`, `Package`
- Edges: `IMPORTS`, `DEFINES`, `CALLS`, `INHERITS`

### 9.2 Key Changes

- Extend ingestion to emit and store:
  - function call edges (`CALLS`)
  - inheritance edges (`INHERITS`)
  - fine-grained defines (file defines functions/classes)
- Refactor GraphService to use Cypher queries for:
  - dependency retrieval
  - cycle detection
  - impact analysis (function-level and file-level)
- Update the frontend to support:
  - edge-type filtering (`IMPORTS` vs `CALLS` vs `INHERITS`)
  - node expansion (File → inner functions/classes)

### 9.3 Timeline

Week 1:

1. Ensure Memgraph connectivity and schema bootstrapping.
2. Extend ingestion to populate entity nodes/edges.
3. Refactor GraphService queries to be Memgraph-backed.

Week 2:

4. Improve `query_code_graph` schema prompt and translation.
5. Enhance Graph UI for entity-level visualization.
6. Regression tests and performance validation.
