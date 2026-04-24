# CodeRover Graph Intelligence vs code-graph-rag: Gap Analysis & Implementation Status

## 1. Core Feature Comparison

| Feature | code-graph-rag (Reference) | CodeRover (Current) | CodeRover (Target) | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Parsing** | Tree-sitter (Multi-lang) | TypeScript (AST), Tree-sitter (Others) | Unified Tree-sitter for all | ✅ Mixed (TS uses AST, Python uses Tree-sitter) |
| **Graph Granularity** | Entity-level (Function, Class, Call) | File-level (File, Symbol, Import) | **Entity-level** (Function, Class, Call, Inheritance) | ✅ **Implemented** |
| **Storage** | Memgraph (Graph DB) | Postgres (Relational) + Memgraph | Postgres + Memgraph | ✅ **Implemented** |
| **Querying** | Natural Language to Cypher | REST API (Fixed) | **NL -> Cypher via MCP** | ✅ **Implemented** |
| **Edges** | `CALLS`, `INHERITS`, `IMPORTS` | `IMPORTS`, `DEFINES` | `CALLS`, `INHERITS`, `IMPORTS`, `DEFINES` | ✅ **Implemented** |

## 2. Implementation Details (Phase 7 Completed)

### 2.1 Data Ingestion (`src/ingest/`)
- **TypeScript**: Updated `AstService` to extract methods, call sites, and inheritance relationships using AST traversal.
- **Python**: Updated `MultiLangAstService` to extract classes, methods, and calls using Tree-sitter.
- **Persistence**: 
  - Created `CodeMethod`, `CodeCall`, `CodeInheritance` entities.
  - Added migration `006_entity_graph` to create corresponding tables.
  - Updated `EmbedderService` to persist extracted entities alongside code chunks.

### 2.2 Graph Construction (`src/graph/`)
- **Memgraph Schema**: Added indexes for `Function`, `Method`, `Class` labels.
- **Sync Logic**: Refactored `GraphService.syncRepoToMemgraph` to:
  1. Sync `File` nodes (existing).
  2. Sync `Class` and `Method` nodes from `code_methods` table.
  3. Sync `Function` nodes (upgraded from symbols).
  4. Sync `INHERITS` edges from `code_inheritance` table.
  5. Sync `CALLS` edges from `code_calls` table (resolving caller/callee by name).

### 2.3 Natural Language Querying (`src/mcp/`)
- **MCP Tool**: Updated `query_code_graph` tool with the new schema definition.
- **Capabilities**: Now supports queries like "Which functions call `login`?" or "Show inheritance hierarchy of `BaseController`".

## 3. Remaining Tasks / Future Improvements
- [ ] **Expand Language Support**: Implement `extractMethods` / `extractCalls` for Go, Java, Rust in `MultiLangAstService`.
- [ ] **Precise Call Resolution**: Improve `CALLS` edge creation by resolving imports instead of just name matching (which can be ambiguous).
- [ ] **Frontend Visualization**: Update React Flow graph to show Class/Function nodes when zoomed in (currently shows Files).

## 4. How to Verify
1. **Ingest a Repo**: Run the ingestion pipeline on a TS or Python repo.
2. **Check Postgres**: Verify `code_methods`, `code_calls`, `code_inheritance` tables are populated.
3. **Check Memgraph**: Run `MATCH (n) RETURN labels(n), count(n)` to see `Class`, `Method`, `Function` nodes.
4. **Query via MCP**: Use the `query_code_graph` tool with a natural language question.
