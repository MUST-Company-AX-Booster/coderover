/**
 * SQLite schema for local-mode MCP — non-vector tables.
 *
 * The virtual `code_chunks_vec` table lives in a separate migration (002)
 * because it requires the `sqlite-vec` extension to be loaded first.
 *
 * Statements use `IF NOT EXISTS` so re-running is a no-op; the migrator
 * still guards double-execution via the `_migrations` ledger, but belt and
 * suspenders here is cheap.
 */

export const INITIAL_SCHEMA_STATEMENTS: readonly string[] = [
  // Chunks: what we index and retrieve.
  `CREATE TABLE IF NOT EXISTS code_chunks (
     id            TEXT PRIMARY KEY,
     file_path     TEXT NOT NULL,
     line_start    INTEGER NOT NULL,
     line_end      INTEGER NOT NULL,
     content       TEXT NOT NULL,
     language      TEXT NOT NULL,
     content_hash  TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_code_chunks_file ON code_chunks(file_path)`,

  // Symbols: for find_symbol + as node_ids for find_dependencies.
  `CREATE TABLE IF NOT EXISTS symbols (
     node_id    TEXT PRIMARY KEY,
     chunk_id   TEXT NOT NULL REFERENCES code_chunks(id),
     kind       TEXT NOT NULL,
     name       TEXT NOT NULL,
     qualified  TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)`,

  // Imports: cheap, cross-file dependency edges.
  `CREATE TABLE IF NOT EXISTS imports (
     edge_id      TEXT PRIMARY KEY,
     src_file     TEXT NOT NULL,
     target_path  TEXT NOT NULL,
     confidence   TEXT NOT NULL DEFAULT 'EXTRACTED'
   )`,
  `CREATE INDEX IF NOT EXISTS idx_imports_src ON imports(src_file)`,
  `CREATE INDEX IF NOT EXISTS idx_imports_target ON imports(target_path)`,

  // File hash index: incremental reingest gate (reuses Phase 10 C1/C2 pattern).
  `CREATE TABLE IF NOT EXISTS file_hashes (
     file_path   TEXT PRIMARY KEY,
     sha256      TEXT NOT NULL,
     indexed_at  INTEGER NOT NULL
   )`,
];
