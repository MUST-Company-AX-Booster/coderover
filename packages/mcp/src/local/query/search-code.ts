/**
 * Phase 11 Wave 3 — L12: `search_code` query over SQLite + sqlite-vec.
 *
 * Flow:
 *   1. Embed the query string via the injected {@link Embedder}.
 *   2. Run a KNN lookup against the `code_chunks_vec` virtual table.
 *   3. Load the corresponding chunk rows from `code_chunks`.
 *   4. Rerank with a small lexical-overlap bonus so an exact token match
 *      beats a slightly-closer but semantically unrelated chunk.
 *   5. Truncate to `limit` and return a {@link SearchCodeResponse} whose
 *      shape is byte-identical to remote mode (so `LocalTransport` can use
 *      it as a drop-in fixture replacement).
 *
 * KNN syntax notes (sqlite-vec is pre-1.0; docs are patchy):
 *   - `embedding MATCH vec_f32(?)` accepts a JSON-array string, e.g.
 *     `'[0.1, 0.2, ...]'`. We use `JSON.stringify(vec)` which is
 *     byte-compatible with sqlite-vec's parser (`vec_f32` treats the
 *     JSON array as a float32 array).
 *   - Limit the KNN pool via `LIMIT ?` on the virtual-table query. The
 *     `k = ?` form exists in later sqlite-vec builds but the Wave 1 seam
 *     test (`test/local/db/sqlite-vec.spec.ts`) already proved `LIMIT`
 *     works with the 0.1.6 pin in `package.json` — stick with it.
 *   - `distance` is a normalized L2 distance in [0, 2] when vectors are
 *     unit-length. Our cosine proxy is `1 - distance / 2`, clamped to
 *     [0, 1] defensively because non-unit vectors can escape the range.
 *
 * Pure data access: no filesystem, no network, no MCP. The caller owns
 * the DB handle and the embedder.
 */

import type Database from 'better-sqlite3';
import type { Embedder } from '../embed/types';
import type { SearchCodeResponse, SearchCodeResult } from './types';

/** Default number of hits returned to the caller. Matches remote-mode UX. */
const DEFAULT_LIMIT = 5;

/**
 * Default KNN pool size. We ask sqlite-vec for 4x the final `limit` so the
 * lexical rerank has headroom to pull a slightly-more-distant chunk ahead
 * of a tightly-ranked but non-matching one.
 */
const DEFAULT_KNN_CANDIDATES = 20;

/** Max chars written into `SearchCodeResult.preview`. */
const PREVIEW_LENGTH = 120;

/**
 * Cap on the lexical-overlap bonus. Keeps the semantic signal dominant —
 * a 0.1 swing is enough to resolve ties / near-ties but can't push a
 * completely unrelated chunk to the top.
 */
const LEXICAL_BONUS_CAP = 0.1;

export interface SearchCodeOptions {
  db: Database.Database;
  embedder: Embedder;
  /** Default {@link DEFAULT_LIMIT}. */
  limit?: number;
  /** Default {@link DEFAULT_KNN_CANDIDATES}. */
  knnCandidates?: number;
}

/**
 * Internal row shape returned by the KNN join query. Matches the literal
 * columns selected — keep in sync with the SQL below.
 */
interface CandidateRow {
  id: string;
  file_path: string;
  line_start: number;
  line_end: number;
  content: string;
  distance: number;
}

/**
 * Embed the query, run KNN, rerank, and return hits.
 *
 * Never throws on empty results — empty DB, no embeddings, or zero KNN
 * hits all return `{ query, results: [] }`. Callers shouldn't have to
 * special-case the "nothing indexed yet" path.
 */
export async function searchCode(
  query: string,
  opts: SearchCodeOptions,
): Promise<SearchCodeResponse> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const knnCandidates = opts.knnCandidates ?? DEFAULT_KNN_CANDIDATES;

  // 1. Embed. The embedder contract guarantees `vectors[0]` exists when
  //    input has one element — it throws on partial failure (see types.ts).
  const { vectors } = await opts.embedder.embed({ input: [query] });
  const queryVec = vectors[0];
  if (!queryVec || queryVec.length === 0) {
    return { query, results: [] };
  }

  // 2. KNN on the virtual table. We ask for `knnCandidates` rows so the
  //    rerank has a healthy pool; we trim to `limit` after reranking.
  //    The `JSON.stringify` form is sqlite-vec's native literal syntax.
  const vecLiteral = JSON.stringify(queryVec);

  // sqlite-vec requires an explicit `k = ?` constraint on vec0 KNN
  // queries (LIMIT alone isn't accepted). We join `code_chunks_vec`
  // (virtual, KNN-indexed) against `code_chunks` (storage) so the caller
  // gets both the distance and the full chunk row in one round-trip.
  const sql = `
    SELECT c.id           AS id,
           c.file_path    AS file_path,
           c.line_start   AS line_start,
           c.line_end     AS line_end,
           c.content      AS content,
           v.distance     AS distance
      FROM code_chunks_vec v
      JOIN code_chunks c ON c.id = v.chunk_id
     WHERE v.embedding MATCH vec_f32(?)
       AND k = ?
     ORDER BY v.distance
  `;

  let candidates: CandidateRow[];
  try {
    candidates = opts.db.prepare(sql).all(vecLiteral, knnCandidates) as CandidateRow[];
  } catch (err) {
    // Surface the SQL error with context; callers see "search_code failed"
    // plus the underlying message instead of a cryptic SQLITE_ERROR.
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`search_code KNN query failed: ${msg}`);
  }

  if (candidates.length === 0) {
    return { query, results: [] };
  }

  // 3. Rerank. Compute a cosine proxy per row, add a capped lexical bonus,
  //    then sort descending. Stable-ish sort is fine; sqlite-vec already
  //    returned rows in distance order so ties keep their KNN order.
  const queryTokens = tokenize(query);
  const scored = candidates.map((row) => {
    // Scale cosine to leave room for the bonus below 1.0 — otherwise a
    // perfect cosine (distance=0) saturates the clamp and the bonus
    // cannot break ties.
    const cosine = cosineFromDistance(row.distance) * (1 - LEXICAL_BONUS_CAP);
    const lexical = lexicalBonus(queryTokens, row.content);
    return { row, score: clamp01(cosine + lexical) };
  });
  scored.sort((a, b) => b.score - a.score);

  // 4. Trim, project to the public shape.
  const results: SearchCodeResult[] = scored.slice(0, limit).map(({ row, score }) => ({
    filePath: row.file_path,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    preview: row.content.slice(0, PREVIEW_LENGTH),
    confidence: 'EXTRACTED',
    confidence_score: score,
  }));

  return { query, results };
}

/**
 * L2-distance-to-cosine proxy. sqlite-vec's default distance is L2; for
 * unit-length vectors `L2^2 = 2 * (1 - cos)`, so `cos ≈ 1 - distance / 2`.
 * We don't assume unit vectors (MockEmbedder isn't normalized) — clamp
 * to [0, 1] so non-unit inputs don't produce out-of-range scores.
 */
function cosineFromDistance(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  return clamp01(1 - distance / 2);
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Lowercase-alphanumeric tokenization. Splits on any non-alphanumeric
 * character so identifiers like `AuthService.validate` tokenize into
 * `['authservice', 'validate']` and a chunk mentioning `AuthService`
 * picks up the match.
 *
 * Single-char tokens are dropped — they're almost always noise (`a`,
 * `i`, punctuation that survived) and would inflate the bonus spuriously.
 */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length > 1);
}

/**
 * Fraction of query tokens present in the chunk, multiplied by the cap.
 * Scaled so a chunk containing every query token gets the full
 * `LEXICAL_BONUS_CAP` kick; zero tokens get zero. Never negative.
 */
function lexicalBonus(queryTokens: string[], content: string): number {
  if (queryTokens.length === 0) return 0;
  const contentLower = content.toLowerCase();
  let matches = 0;
  for (const t of queryTokens) {
    if (contentLower.includes(t)) matches++;
  }
  return (matches / queryTokens.length) * LEXICAL_BONUS_CAP;
}
