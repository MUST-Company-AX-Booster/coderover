/**
 * Tests for {@link OfflineEmbedder} (Phase 11 Wave 5 L21).
 *
 * These tests never load the real `@xenova/transformers` — we inject a
 * mock via `transformersModule` so CI doesn't download a ~30 MB ONNX
 * model on every run. The one test that *does* exercise the real
 * `require('@xenova/transformers')` branch expects the package to be
 * absent and asserts we surface a clear install hint.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  OfflineEmbedder,
  OFFLINE_MINILM_DIMENSION,
  TransformersModuleLike,
} from '../../../src/local/embed/offline-embedder';

interface MockTransformersOptions {
  /** Dimension of the fake embedding output. Default matches MiniLM (384). */
  dim?: number;
  /** If true, pipeline() rejects with an error. */
  pipelineShouldThrow?: boolean;
  /** If true, the per-text inference call rejects. */
  inferShouldThrow?: boolean;
  /** Collects pipeline() / inference() calls for assertions. */
  calls?: {
    pipeline: Array<{ task: string; model: string; opts?: unknown }>;
    infer: Array<{ text: string; opts?: unknown }>;
  };
  /** Env pointer the test can inspect after construction. */
  env?: { cacheDir?: string | null };
}

/**
 * Build a fake transformers module. Vectors are constant-fill 0.1s of
 * the requested dim — enough to assert shape + downstream wiring without
 * needing a real model.
 */
function mockTransformers(
  opts: MockTransformersOptions = {},
): TransformersModuleLike {
  const dim = opts.dim ?? OFFLINE_MINILM_DIMENSION;
  const env = opts.env ?? { cacheDir: null };
  const calls = opts.calls;

  return {
    env,
    pipeline: jest.fn(async (task: string, model: string, pipelineOpts?: unknown) => {
      if (calls) calls.pipeline.push({ task, model, opts: pipelineOpts });
      if (opts.pipelineShouldThrow) throw new Error('model load failed');

      return async (text: string, inferOpts?: unknown) => {
        if (calls) calls.infer.push({ text, opts: inferOpts });
        if (opts.inferShouldThrow) throw new Error('inference failed');
        return { data: new Float32Array(dim).fill(0.1) };
      };
    }),
  };
}

describe('OfflineEmbedder', () => {
  it('dimension is 384 (MiniLM-L6-v2)', () => {
    const e = new OfflineEmbedder({ transformersModule: mockTransformers() });
    expect(e.dimension).toBe(384);
    expect(e.dimension).toBe(OFFLINE_MINILM_DIMENSION);
  });

  it('first embed() triggers pipeline(); second call reuses it', async () => {
    const calls = { pipeline: [] as any[], infer: [] as any[] };
    const mod = mockTransformers({ calls });
    const e = new OfflineEmbedder({ transformersModule: mod });

    await e.embed({ input: ['first'] });
    await e.embed({ input: ['second'] });

    expect(calls.pipeline).toHaveLength(1);
    expect(calls.pipeline[0].task).toBe('feature-extraction');
    expect(calls.pipeline[0].model).toBe('Xenova/all-MiniLM-L6-v2');
    expect(calls.infer).toHaveLength(2);
  });

  it('concurrent first calls share a single init (not two loads)', async () => {
    const calls = { pipeline: [] as any[], infer: [] as any[] };
    const mod = mockTransformers({ calls });
    const e = new OfflineEmbedder({ transformersModule: mod });

    await Promise.all([
      e.embed({ input: ['a'] }),
      e.embed({ input: ['b'] }),
      e.embed({ input: ['c'] }),
    ]);

    expect(calls.pipeline).toHaveLength(1);
    expect(calls.infer).toHaveLength(3);
  });

  it('empty input short-circuits without loading the model', async () => {
    const calls = { pipeline: [] as any[], infer: [] as any[] };
    const mod = mockTransformers({ calls });
    const e = new OfflineEmbedder({ transformersModule: mod });

    const res = await e.embed({ input: [] });
    expect(res).toEqual({ vectors: [], tokensUsed: 0 });
    // Short-circuit is important: lets CLI bootstrap probe an embedder
    // without paying for a model download.
    expect(calls.pipeline).toHaveLength(0);
  });

  it('N inputs → N vectors each of length 384', async () => {
    const mod = mockTransformers();
    const e = new OfflineEmbedder({ transformersModule: mod });

    const res = await e.embed({ input: ['one', 'two', 'three', 'four'] });
    expect(res.vectors).toHaveLength(4);
    for (const v of res.vectors) {
      expect(v).toHaveLength(384);
      expect(v.every((x) => typeof x === 'number')).toBe(true);
    }
    // tokensUsed is ceil(len/4) summed; all inputs ≤ 5 chars so each
    // contributes 1 or 2 tokens (ceil(3/4)=1, ceil(5/4)=2). 3+3+5+4 chars.
    expect(res.tokensUsed).toBe(
      Math.ceil(3 / 4) + Math.ceil(3 / 4) + Math.ceil(5 / 4) + Math.ceil(4 / 4),
    );
  });

  it('sets transformers.env.cacheDir before pipeline() is called', async () => {
    const env: { cacheDir?: string | null } = { cacheDir: null };
    const calls = { pipeline: [] as any[], infer: [] as any[] };
    const mod = mockTransformers({ env, calls });

    // Intercept pipeline to snapshot env.cacheDir at call time — we need
    // to prove the cacheDir was set *before* pipeline(), not just that
    // it ends up set eventually.
    let cacheDirAtPipeline: string | null | undefined;
    const origPipeline = mod.pipeline;
    mod.pipeline = jest.fn(async (task, model, opts) => {
      cacheDirAtPipeline = env.cacheDir;
      return origPipeline(task, model, opts);
    });

    const e = new OfflineEmbedder({
      transformersModule: mod,
      cacheDir: '/tmp/coderover-models',
    });
    await e.embed({ input: ['warmup'] });

    expect(cacheDirAtPipeline).toBe('/tmp/coderover-models');
    expect(env.cacheDir).toBe('/tmp/coderover-models');
  });

  it('leaves env.cacheDir untouched when no cacheDir option is given', async () => {
    const env: { cacheDir?: string | null } = { cacheDir: '/pre-existing' };
    const mod = mockTransformers({ env });
    const e = new OfflineEmbedder({ transformersModule: mod });
    await e.embed({ input: ['x'] });
    expect(env.cacheDir).toBe('/pre-existing');
  });

  it('honors a custom modelName', async () => {
    const calls = { pipeline: [] as any[], infer: [] as any[] };
    const mod = mockTransformers({ calls });
    const e = new OfflineEmbedder({
      transformersModule: mod,
      modelName: 'Xenova/some-other-model',
    });
    await e.embed({ input: ['hi'] });
    expect(calls.pipeline[0].model).toBe('Xenova/some-other-model');
  });

  it('propagates pipeline() (model load) errors', async () => {
    const mod = mockTransformers({ pipelineShouldThrow: true });
    const e = new OfflineEmbedder({ transformersModule: mod });
    await expect(e.embed({ input: ['x'] })).rejects.toThrow(/model load failed/);
  });

  it('propagates per-input inference errors', async () => {
    const mod = mockTransformers({ inferShouldThrow: true });
    const e = new OfflineEmbedder({ transformersModule: mod });
    await expect(e.embed({ input: ['x'] })).rejects.toThrow(/inference failed/);
  });

  it('throws when req.input is not an array', async () => {
    const e = new OfflineEmbedder({ transformersModule: mockTransformers() });
    await expect(
      e.embed({ input: null as unknown as string[] }),
    ).rejects.toThrow(/must be an array/);
  });

  it('throws an install-hint error pointing at @coderover/mcp-offline when transformers is missing', async () => {
    // Simulate the package being absent by pointing require at a stub
    // that always throws MODULE_NOT_FOUND. As of 0.3.0 @xenova/transformers
    // is no longer a dependency (direct or optional) of @coderover/mcp;
    // users install the companion `@coderover/mcp-offline` package to
    // get it. The error message should steer them there.
    const e = new OfflineEmbedder({
      requireImpl: (id: string) => {
        const err = new Error(`Cannot find module '${id}'`) as Error & {
          code?: string;
        };
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      },
    });
    await expect(e.embed({ input: ['x'] })).rejects.toThrow(
      /@coderover\/mcp-offline/,
    );
    await expect(e.embed({ input: ['x'] })).rejects.toThrow(
      /npm install @coderover\/mcp-offline/,
    );
  });
});
