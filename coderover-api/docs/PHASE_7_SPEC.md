# Phase 7: Graph Intelligence Technical Specification

## 1. Overview
Phase 7 introduces Graph Intelligence to CodeRover, turning the indexed codebase into an actionable dependency graph. This phase provides the ability to visualize module relationships, detect circular dependencies, analyze the impact of changes, and identify architectural hotspots.

> **Update:** We are expanding Phase 7 to integrate [Code-Graph-RAG](https://github.com/vitali87/code-graph-rag), which upgrades the basic file-level graph to a highly granular, multi-language entity-level graph (Functions, Classes, CALLS, IMPORTS, INHERITS) using **Memgraph** and **Tree-sitter**. For the detailed integration plan, see [CODE_GRAPH_RAG_PLAN.md](./CODE_GRAPH_RAG_PLAN.md).

## 2. Architecture & Components
A new `GraphModule` will be added to the backend (`src/graph`), exposing REST endpoints and internal services for graph computation. 

### 2.1 Services
- **`GraphService`**: 
  - Retrieves `filePath` and `imports` from `code_chunks` scoped by `repoId`.
  - **Graph Construction**: Builds an in-memory directed graph `Node(filePath) -> Edge(importSource)`.
  - **Cycle Detection**: Uses Tarjan's or DFS-based cycle detection algorithm to find circular dependency chains.
  - **Impact Analysis**: Given a target file, traverses the *reverse* dependency graph to identify downstream files that depend on it.
  - **Hotspot Detection**: Calculates the in-degree of all nodes to rank modules by how frequently they are imported.

### 2.2 Controllers
- **`GraphController`** (`src/graph/graph.controller.ts`):
  - `GET /graph/dependencies?repoId=<uuid>&rootModule=<path>`: Returns the dependency tree/graph as JSON (D3-compatible format).
  - `GET /graph/cycles?repoId=<uuid>`: Returns detected circular dependencies.
  - `GET /graph/impact?repoId=<uuid>&filePath=<path>`: Returns reverse-dependency impact analysis.
  - `GET /graph/hotspots?repoId=<uuid>`: Returns top imported modules.

### 2.3 MCP Tool
- **`graph_analysis` Tool** (`src/mcp/tools/graph-analysis.tool.ts`):
  - Provides AI agents the ability to query the dependency graph.
  - **Parameters**: `repoId`, `rootModule`, `analysisType` (cycles, impact, hotspots, tree).

## 3. Database Interactions
- No new tables are strictly required for Phase 7 since the graph can be computed on-demand or cached in-memory/Redis from the existing `code_chunks` JSONB `imports` column. 
- A new query in `SearchService` (or directly in `GraphService` via `DataSource`) will efficiently project `file_path` and `imports` for an entire repo to build the graph:
  ```sql
  SELECT DISTINCT ON (file_path) file_path, imports, module_name
  FROM code_chunks
  WHERE repo_id = $1 AND imports IS NOT NULL
  ```

## 4. Graph Construction Algorithm
1. **Nodes**: Each unique `file_path` forms a node.
2. **Edges**: For each file, iterate through its `imports` (JSONB array). Resolve the import `source` to a matching `file_path` within the repository.
   - *Resolution Logic*: Map relative imports (e.g., `./user.service`) or aliased imports (e.g., `@/user/user.service`) to absolute `file_path`s in the project. This relies on string matching and path normalization.
3. **Cross-Repo**: If an import matches a registered module from another repo, link them (Cross-Repo Graph Linking).

## 5. Security & Testing
- **Auth**: All new REST endpoints will be protected by `@UseGuards(JwtAuthGuard)`.
- **Testing**: Minimum 90% coverage for `GraphService` covering graph building, cycle detection (with mock circular data), impact analysis, and hotspots. E2E tests for the new MCP tool and Controller.

## 6. Frontend Implementation
- **Dependencies**: Added `@xyflow/react` and `dagre` for automated graph layout and node/edge rendering.
- **API Client**: Added `src/lib/api/graph.ts` to expose `getDependencies`, `getCycles`, `getImpact`, and `getHotspots` functions.
- **Graph Page** (`src/pages/GraphPage.tsx`): 
  - Allows repository selection.
  - Implements 4 tabs mapping to the graph features:
    1. **Dependency Graph**: Uses React Flow + Dagre to auto-layout the full module dependency tree.
    2. **Hotspots**: Tabular ranking of modules by `inDegree` to quickly identify bottlenecks.
    3. **Cycles**: Displays circular dependency chains in an easy-to-read list.
    4. **Impact Analysis**: Provides a search form to query a specific file path and list all downstream impacted files.
- **Routing**: Added `/graph` route to `App.tsx` and a "Graph Intelligence" navigation link to the sidebar in `Layout.tsx`.

## 7. Documentation Updates
- Update `Swagger` documentation via `@ApiTags('Graph')`, `@ApiOperation()`, etc.
- Update `AI_COPILOT_ROADMAP_v1.md` to mark Phase 7 as completed.
- Update `README.md` to highlight Graph Intelligence features.