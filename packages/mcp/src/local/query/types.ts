/**
 * Response shapes for local-mode MCP query tools (Phase 11 Wave 3, L12–L14).
 *
 * These types MUST stay byte-for-byte compatible with the remote-mode
 * payloads produced by the backend (`coderover-api`) and consumed by the
 * `LocalTransport` drop-in in `packages/mcp/src/transport/local-transport.ts`.
 * See `packages/mcp-integration/src/scenarios/mcp-tools.spec.ts` (lines
 * 88–212) for the canonical fixture shapes.
 *
 * Field rules inherited from remote mode:
 *   - `confidence` is a string tag, not a number. Local mode is always
 *     AST-derived, so we emit the literal `'EXTRACTED'` everywhere
 *     (`search_code` included — cosine similarity is the SCORE, not the
 *     confidence tag; see L12 for why).
 *   - `confidence_score` is a number in [0, 1]. Symbols / dependencies are
 *     always `1.0` because they come straight from the AST / import graph.
 *     Only `search_code` has a variable score.
 *   - `filePath` is the repo-relative POSIX path exactly as stored in
 *     `code_chunks.file_path` / `imports.src_file` / `imports.target_path`.
 *
 * Keep these as plain object types (no classes, no discriminated unions)
 * so `JSON.stringify(response)` produces the exact payload remote mode
 * produces and `LocalTransport` doesn't have to massage anything.
 */

/** Single hit from `search_code`. `preview` is the first ~120 chars of the chunk. */
export interface SearchCodeResult {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  /** First ~120 characters of `code_chunks.content`; intentionally raw. */
  preview: string;
  /** Always `'EXTRACTED'` in local mode — chunks are AST-derived. */
  confidence: 'EXTRACTED';
  /** Cosine similarity in [0, 1] plus a capped lexical bonus. */
  confidence_score: number;
}

export interface SearchCodeResponse {
  query: string;
  results: SearchCodeResult[];
}

/** Single hit from `find_symbol`. */
export interface FindSymbolResult {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  /** Deterministic ID from `symbols.node_id`; never recomputed here. */
  node_id: string;
  confidence: 'EXTRACTED';
  confidence_score: 1.0;
}

export interface FindSymbolResponse {
  symbolName: string;
  results: FindSymbolResult[];
  totalFound: number;
}

/** Upstream/downstream dependency entry from `find_dependencies`. */
export interface FindDependenciesEntry {
  filePath: string;
  confidence: 'EXTRACTED';
  confidence_score: 1.0;
}

export interface FindDependenciesResponse {
  target: string;
  upstream: FindDependenciesEntry[];
  downstream: FindDependenciesEntry[];
}
