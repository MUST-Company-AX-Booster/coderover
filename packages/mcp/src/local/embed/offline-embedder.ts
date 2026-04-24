/**
 * Offline embedder backed by Transformers.js + MiniLM (Phase 11 Wave 5 L21).
 *
 * Wraps `Xenova/all-MiniLM-L6-v2` (~30 MB quantized ONNX weights, 384-dim
 * sentence embeddings) via `@xenova/transformers`. After the one-time model
 * download this embedder runs entirely offline — no network, no keys — which
 * is the whole point vs. {@link OpenAIEmbedder}.
 *
 * Wire via `CODEROVER_EMBED_MODE=offline` through `shared.ts::buildEmbedder`.
 * As of 0.3.0 the transformers package ships in a separate companion
 * package — `@coderover/mcp-offline` — so remote-mode and openai-embed
 * users never pay the 45 MB ONNX runtime install cost (or its 5-CVE
 * transitive chain via protobufjs). We `require('@xenova/transformers')`
 * lazily on first `embed()`; when the companion package isn't installed
 * the require fails and we surface a clear install hint.
 *
 * Dimension note: MiniLM-L6-v2 is 384-dim, not the 1536 used by
 * `text-embedding-3-small`. The caller (shared.ts) is responsible for
 * creating `code_chunks_vec` at dim 384 when running in offline mode.
 * Mixing embedders in the same DB is rejected at open time with a
 * "delete + reindex" error; see `openIndexedDb`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Embedder, EmbedRequest, EmbedResponse } from './types';
import { OFFLINE_MINILM_DIMENSION } from './types';

export { OFFLINE_MINILM_DIMENSION };

/**
 * Minimal shape of the `@xenova/transformers` module we rely on. Typed
 * loosely because we don't want to pull the package's `.d.ts` into the
 * always-compiled surface — it's an optional dep.
 */
export interface TransformersModuleLike {
  env: { cacheDir?: string | null; [k: string]: any };
  pipeline: (task: string, model: string, opts?: unknown) => Promise<any>;
}

export interface OfflineEmbedderOptions {
  /** Model id on HuggingFace Hub. Default `Xenova/all-MiniLM-L6-v2`. */
  modelName?: string;
  /**
   * Inject a transformers-module stand-in. Used exclusively by tests so
   * CI doesn't have to download ~30 MB of ONNX weights. Production code
   * leaves this undefined and we `require('@xenova/transformers')`.
   */
  transformersModule?: TransformersModuleLike;
  /**
   * Override the on-disk cache directory where Transformers.js stores
   * downloaded weights. Defaults to the library's own setting (typically
   * `~/.cache/huggingface/hub`). Exposed so callers can redirect it into
   * `~/.coderover/models` or similar.
   */
  cacheDir?: string;
  /**
   * Test-only: override the `require()` call used to load
   * `@xenova/transformers`. Lets the missing-module branch be exercised
   * in CI without actually uninstalling the optional dep. Leave unset
   * in production.
   */
  requireImpl?: (id: string) => unknown;
}

/**
 * Transformers.js-backed {@link Embedder}. Lazy-loads the ONNX model on
 * first `embed()` call; subsequent calls reuse the cached pipeline.
 */
export class OfflineEmbedder implements Embedder {
  readonly dimension = OFFLINE_MINILM_DIMENSION;
  readonly modeLabel = 'offline' as const;

  private readonly modelName: string;
  private readonly transformersModule?: TransformersModuleLike;
  private readonly cacheDir?: string;
  private readonly requireImpl?: (id: string) => unknown;

  /** Resolved pipeline closure; unset until first `ensureReady()` completes. */
  private pipelineFn?: (text: string) => Promise<{ data: Float32Array }>;
  /** In-flight init promise — ensures concurrent first calls share one load. */
  private initPromise?: Promise<void>;

  constructor(opts: OfflineEmbedderOptions = {}) {
    this.modelName = opts.modelName ?? 'Xenova/all-MiniLM-L6-v2';
    this.transformersModule = opts.transformersModule;
    this.cacheDir = opts.cacheDir;
    this.requireImpl = opts.requireImpl;
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    if (!req || !Array.isArray(req.input)) {
      throw new Error('OfflineEmbedder.embed: req.input must be an array');
    }
    if (req.input.length === 0) {
      return { vectors: [], tokensUsed: 0 };
    }

    // Model load is expensive (~hundreds of ms even with a warm cache) so
    // we defer it until the first embed() call. Concurrent callers share
    // the same promise, not two parallel downloads.
    await this.ensureReady();

    const vectors: number[][] = [];
    let tokensUsed = 0;
    for (const text of req.input) {
      const out = await this.pipelineFn!(text);
      vectors.push(Array.from(out.data));
      // Rough token approximation (4 chars ≈ 1 token). Transformers.js
      // doesn't hand us an exact token count and spinning up the WordPiece
      // tokenizer just to report stats isn't worth the ms.
      tokensUsed += Math.ceil(text.length / 4);
    }
    return { vectors, tokensUsed };
  }

  private async ensureReady(): Promise<void> {
    if (this.pipelineFn) return;
    if (!this.initPromise) {
      this.initPromise = this.doInit();
    }
    await this.initPromise;
  }

  private async doInit(): Promise<void> {
    let transformers: TransformersModuleLike;
    if (this.transformersModule) {
      transformers = this.transformersModule;
    } else {
      try {
        // Lazy require: skipping this at module load keeps the OpenAI /
        // remote path zero-cost on installs where `@xenova/transformers`
        // isn't present.
        const req =
          this.requireImpl ??
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          ((id: string) => require(id));
        transformers = req('@xenova/transformers') as TransformersModuleLike;
      } catch (err) {
        const orig = err instanceof Error ? err.message : String(err);
        throw new Error(
          'CODEROVER_EMBED_MODE=offline requires the companion package ' +
            '@coderover/mcp-offline, which bundles @xenova/transformers.\n\n' +
            '  npm install @coderover/mcp-offline\n\n' +
            'Previously this was an `optionalDependencies` of @coderover/mcp, ' +
            'but the 45 MB ONNX runtime it pulled in (plus a 5-CVE transitive ' +
            'chain via protobufjs) was unwanted weight on every install. The ' +
            'split lets remote-mode and openai-embed users skip it entirely.\n\n' +
            `Original error: ${orig}`,
        );
      }
    }

    if (this.cacheDir && transformers.env) {
      transformers.env.cacheDir = this.cacheDir;
    }

    // The `feature-extraction` pipeline returns a per-token tensor; we
    // ask for mean-pooling + L2 normalization to collapse that to a
    // single 384-dim sentence vector suitable for cosine KNN in sqlite-vec.
    // `quantized: true` keeps the model ~30 MB instead of ~90 MB.
    const pipe = await transformers.pipeline(
      'feature-extraction',
      this.modelName,
      { quantized: true },
    );

    this.pipelineFn = async (text: string) => {
      const out = await pipe(text, { pooling: 'mean', normalize: true });
      return { data: out.data as Float32Array };
    };
  }
}
