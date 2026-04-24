/**
 * Embedder interface for local-mode MCP (Phase 11 Wave 3 L10).
 *
 * One abstraction, two call sites:
 *
 *   1. **Index time** — batch-embed all new/changed chunks produced by
 *      the Wave 2 chunker, then insert the vectors into the sqlite-vec
 *      virtual table `code_chunks_vec` from Wave 1.
 *   2. **Query time** — embed a single user query string and run KNN
 *      against `code_chunks_vec`.
 *
 * The surface is intentionally narrow compared with the backend
 * `coderover-api/src/ingest/embedder.service.ts` — local mode is
 * OpenAI-only, fixed to `text-embedding-3-small` (1536 dims), with no
 * BM25 fallback and no DB-backed dimension tracking. Callers that need
 * richer behaviour should stay on the backend path.
 *
 * `embed` is fail-loud: on any batch failure the whole call rejects so
 * callers never see a half-embedded input array. Partial success would
 * make the SQLite write path much harder to reason about (which rows
 * got a vector, which didn't).
 */

/** Input batch for {@link Embedder.embed}. Order is preserved in the response. */
export interface EmbedRequest {
  input: string[];
}

/**
 * Result of an {@link Embedder.embed} call.
 *
 * `vectors[i]` corresponds to `req.input[i]`. Length always equals
 * `req.input.length` on success. `tokensUsed` is summed across all
 * underlying provider requests when batching is involved.
 */
export interface EmbedResponse {
  vectors: number[][];
  tokensUsed: number;
}

/**
 * Strategy-style interface. Prod code wires {@link OpenAIEmbedder}; tests
 * and offline dev wire {@link MockEmbedder}. Callers depend only on this
 * interface so swapping providers is a constructor change.
 */
export interface Embedder {
  /** Embed one or more strings. Throws on network/provider failure. */
  embed(req: EmbedRequest): Promise<EmbedResponse>;
  /** Vector dimension this embedder produces. */
  readonly dimension: number;
  /**
   * Stable label identifying the embedder kind (e.g. `'mock'`,
   * `'openai'`, `'offline'`). Optional so adapters added outside this
   * package don't have to set it; callers that surface this in user-
   * facing payloads (e.g. `LocalTransport` stamping `meta.embedder` on
   * `search_code` results) treat `undefined` the same as an unknown
   * provider.
   */
  readonly modeLabel?: 'mock' | 'openai' | 'offline';
}

/**
 * Well-known dimensions for the embedders local mode currently supports.
 * Exported so the CLI bootstrap + vec-table migration can agree on the
 * number without each end hard-coding its own constant.
 *
 * - {@link DEFAULT_OPENAI_DIMENSION} — `text-embedding-3-small`, the
 *   Wave 3 default.
 * - {@link OFFLINE_MINILM_DIMENSION} — `Xenova/all-MiniLM-L6-v2`, the
 *   Wave 5 opt-in offline embedder (Transformers.js).
 */
export const DEFAULT_OPENAI_DIMENSION = 1536;
export const OFFLINE_MINILM_DIMENSION = 384;
