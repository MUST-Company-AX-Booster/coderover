/**
 * Deterministic chunk identity for local-mode MCP.
 *
 * A code chunk is keyed by `(filePath, lineStart, lineEnd, symbolKind,
 * symbolName)`. `lineStart`/`lineEnd` alone are not enough: the chunker
 * emits a class AND each of its methods as standalone chunks, and a
 * single-line class like `class A { m() {} }` produces two chunks whose
 * line spans are identical. Folding `symbolKind`/`symbolName` into the
 * hash makes those chunks distinguishable. Unspecified kind/name default
 * to empty strings — that's the whole-file fallback case.
 *
 * The tuple is stable across repeat ingests of an unchanged file, which
 * is the property `code_chunks.id` relies on to be idempotent. If two
 * distinct ingests of the same file produce different chunk IDs we'd
 * churn the SQLite table and the vector index (vec0 does NOT honor
 * `INSERT OR REPLACE` — on a PK collision it throws a UNIQUE constraint
 * error, which is the failure mode this extra disambiguation prevents).
 *
 * Mirrors the contract in `../deterministic-ids.ts`:
 *   - SHA-256, lowercase hex, truncated to 16 chars (8 bytes, 64 bits).
 *   - Unit-separator `\x1f` between fields so no legal filePath / name
 *     character can collide with the separator.
 *
 * Not the same hash as `computeNodeId` (different field tuple), and not
 * required to be — chunk IDs live in `code_chunks`, node IDs live in
 * `symbols`. The two namespaces are joined via `symbols.chunk_id`.
 *
 * Pure function, no DI — callable from ingestion, tests, and migrations.
 */

import { createHash } from 'crypto';

const SEPARATOR = '\x1f';
const ID_LENGTH_HEX = 16;

export function computeChunkId(
  filePath: string,
  lineStart: number,
  lineEnd: number,
  symbolKind?: string,
  symbolName?: string,
): string {
  if (filePath == null || lineStart == null || lineEnd == null) {
    throw new Error(
      `computeChunkId: all three fields are required (filePath=${filePath!}, lineStart=${lineStart!}, lineEnd=${lineEnd!})`,
    );
  }
  const input = [
    filePath,
    String(lineStart),
    String(lineEnd),
    symbolKind ?? '',
    symbolName ?? '',
  ].join(SEPARATOR);
  return createHash('sha256').update(input).digest('hex').slice(0, ID_LENGTH_HEX);
}

/** Length of the returned chunk ID in hex characters. Exposed for tests / docs. */
export const CHUNK_ID_HEX_LENGTH = ID_LENGTH_HEX;
