/**
 * Embedder implementations for local-mode MCP (Phase 11 Wave 3 L10).
 *
 * Two concrete types live here:
 *
 *   - {@link OpenAIEmbedder} — the production adapter. Wraps
 *     {@link OpenAIEmbedClient} with batching. `text-embedding-3-small`
 *     is fixed-dimension 1536; we expose that as a readonly field so
 *     callers wiring the sqlite-vec `code_chunks_vec` table (float[1536])
 *     don't have to guess.
 *
 *   - {@link MockEmbedder} — test/offline double. Deterministic vectors
 *     derived from a SHA-256 hash of the input string, normalized to
 *     [-1, 1]. Zero network, zero randomness, same input → same vector.
 *     Lives in this file (not a test helper) so consumers of the package
 *     can wire it for dev / CI runs without pulling in test-only paths.
 *
 * Batching contract: `OpenAIEmbedder.embed` splits `req.input` into
 * chunks of `batchSize` (default 100, OpenAI's hard limit is 2048) and
 * issues one client call per batch. Results are stitched in input order;
 * `tokensUsed` is summed across batches. Any batch rejection rejects the
 * whole call — we never return partial results. See `types.ts` for why.
 */

import { createHash } from 'crypto';

import { OpenAIEmbedClient, OpenAIClientOptions } from './openai-client';
import { Embedder, EmbedRequest, EmbedResponse } from './types';

/** `text-embedding-3-small` dimension — fixed by the model. */
const TEXT_EMBEDDING_3_SMALL_DIMENSION = 1536;
const DEFAULT_BATCH_SIZE = 100;

export interface OpenAIEmbedderOptions extends OpenAIClientOptions {
  /**
   * Max inputs per OpenAI request. OpenAI's hard limit is 2048; 100 is a
   * conservative default that keeps individual request payloads small
   * (helps with retries and rate-limit headroom).
   */
  batchSize?: number;
}

export class OpenAIEmbedder implements Embedder {
  readonly dimension = TEXT_EMBEDDING_3_SMALL_DIMENSION;
  readonly modeLabel = 'openai' as const;

  private readonly client: OpenAIEmbedClient;
  private readonly batchSize: number;

  constructor(opts: OpenAIEmbedderOptions) {
    const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error(
        `OpenAIEmbedder: batchSize must be a positive integer, got ${batchSize}`,
      );
    }
    this.batchSize = batchSize;
    this.client = new OpenAIEmbedClient(opts);
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    if (!req || !Array.isArray(req.input)) {
      throw new Error('OpenAIEmbedder.embed: req.input must be an array');
    }
    if (req.input.length === 0) {
      return { vectors: [], tokensUsed: 0 };
    }

    const vectors: number[][] = [];
    let tokensUsed = 0;

    for (let i = 0; i < req.input.length; i += this.batchSize) {
      const batch = req.input.slice(i, i + this.batchSize);
      // Any rejection here propagates — intentional fail-loud behaviour.
      // Partial success would leave callers with a `vectors` array of
      // uncertain length relative to `req.input`.
      const result = await this.client.embed(batch);
      if (result.vectors.length !== batch.length) {
        throw new Error(
          `OpenAIEmbedder: batch returned ${result.vectors.length} vectors for ${batch.length} inputs`,
        );
      }
      for (const v of result.vectors) vectors.push(v);
      tokensUsed += result.tokensUsed;
    }

    return { vectors, tokensUsed };
  }
}

/**
 * Deterministic offline embedder. Same input string → same vector,
 * every call, no network. Used by tests and by `--mock` dev runs that
 * want to exercise the full ingest → store → query loop without
 * paying OpenAI.
 *
 * Construction:
 *   - Hash input with SHA-256 (32 bytes).
 *   - Stream bytes from repeated SHA-256 of `hash || counter` until
 *     we have `dimension` bytes.
 *   - Normalize each byte `b` to `(b / 127.5) - 1`, giving [-1, 1).
 *
 * Not a real embedding — no semantic similarity guarantees — but the
 * vector is dimension-correct and stable, which is all downstream
 * tests need.
 */
export class MockEmbedder implements Embedder {
  readonly dimension: number;
  readonly modeLabel = 'mock' as const;

  constructor(dimension = TEXT_EMBEDDING_3_SMALL_DIMENSION) {
    if (!Number.isInteger(dimension) || dimension < 1) {
      throw new Error(
        `MockEmbedder: dimension must be a positive integer, got ${dimension}`,
      );
    }
    this.dimension = dimension;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    if (!req || !Array.isArray(req.input)) {
      throw new Error('MockEmbedder.embed: req.input must be an array');
    }
    const vectors = req.input.map((s) => this.vectorFor(s));
    // Approximate token count so callers that sum `tokensUsed` see a
    // plausible non-zero number without paying for a tokenizer.
    const tokensUsed = req.input.reduce((sum, s) => sum + Math.ceil(s.length / 4), 0);
    return { vectors, tokensUsed };
  }

  private vectorFor(input: string): number[] {
    const bytes = this.deriveBytes(input, this.dimension);
    const v = new Array<number>(this.dimension);
    for (let i = 0; i < this.dimension; i++) {
      // Map 0..255 byte to [-1, 1).
      v[i] = bytes[i] / 127.5 - 1;
    }
    return v;
  }

  private deriveBytes(input: string, n: number): Buffer {
    // One SHA-256 gives 32 bytes. Chain counter-suffixed hashes to fill
    // arbitrary lengths deterministically.
    const chunks: Buffer[] = [];
    let total = 0;
    let counter = 0;
    const base = createHash('sha256').update(input).digest();
    while (total < n) {
      const h = createHash('sha256');
      h.update(base);
      const ctr = Buffer.alloc(4);
      ctr.writeUInt32BE(counter, 0);
      h.update(ctr);
      const chunk = h.digest();
      chunks.push(chunk);
      total += chunk.length;
      counter++;
    }
    return Buffer.concat(chunks, total).subarray(0, n);
  }
}
