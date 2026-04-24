/**
 * Tests for OpenAIEmbedder batching + MockEmbedder determinism.
 */

import { OpenAIEmbedder, MockEmbedder } from '../../../src/local/embed/embedder';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function okEmbedBody(vectors: number[][], totalTokens = 0): unknown {
  return {
    data: vectors.map((embedding, index) => ({ embedding, index })),
    usage: { total_tokens: totalTokens },
  };
}

describe('OpenAIEmbedder', () => {
  it('dimension is 1536 (text-embedding-3-small)', () => {
    const e = new OpenAIEmbedder({ apiKey: 'sk', fetchImpl: jest.fn() });
    expect(e.dimension).toBe(1536);
  });

  it('embeds a single batch when input.length <= batchSize', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(200, okEmbedBody([[0.1], [0.2]], 6)),
    );
    const e = new OpenAIEmbedder({ apiKey: 'sk', batchSize: 100, fetchImpl });
    const res = await e.embed({ input: ['a', 'b'] });
    expect(res.vectors).toEqual([[0.1], [0.2]]);
    expect(res.tokensUsed).toBe(6);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('splits across multiple batches and stitches in input order', async () => {
    const batchSize = 50;
    const inputs = Array.from({ length: 120 }, (_, i) => `chunk-${i}`);
    const fetchImpl = jest
      .fn()
      // batch 1: 50 vectors, 10 tokens
      .mockResolvedValueOnce(
        jsonResponse(
          200,
          okEmbedBody(
            inputs.slice(0, 50).map((_, i) => [i]),
            10,
          ),
        ),
      )
      // batch 2: 50 vectors, 20 tokens
      .mockResolvedValueOnce(
        jsonResponse(
          200,
          okEmbedBody(
            inputs.slice(50, 100).map((_, i) => [50 + i]),
            20,
          ),
        ),
      )
      // batch 3: 20 vectors, 7 tokens
      .mockResolvedValueOnce(
        jsonResponse(
          200,
          okEmbedBody(
            inputs.slice(100, 120).map((_, i) => [100 + i]),
            7,
          ),
        ),
      );
    const e = new OpenAIEmbedder({ apiKey: 'sk', batchSize, fetchImpl });
    const res = await e.embed({ input: inputs });
    expect(res.vectors).toHaveLength(120);
    expect(res.vectors[0]).toEqual([0]);
    expect(res.vectors[119]).toEqual([119]);
    expect(res.tokensUsed).toBe(37);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('a single batch rejection rejects the whole embed()', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, okEmbedBody([[1]], 1)))
      .mockResolvedValueOnce(jsonResponse(400, { error: { message: 'bad' } }));
    const e = new OpenAIEmbedder({
      apiKey: 'sk',
      batchSize: 1,
      fetchImpl,
    });
    await expect(e.embed({ input: ['a', 'b'] })).rejects.toThrow(/400/);
  });

  it('empty input returns empty response without calling fetch', async () => {
    const fetchImpl = jest.fn();
    const e = new OpenAIEmbedder({ apiKey: 'sk', fetchImpl });
    const res = await e.embed({ input: [] });
    expect(res.vectors).toEqual([]);
    expect(res.tokensUsed).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws when batchSize is not a positive integer', () => {
    expect(() =>
      new OpenAIEmbedder({ apiKey: 'sk', batchSize: 0, fetchImpl: jest.fn() }),
    ).toThrow(/batchSize/);
    expect(() =>
      new OpenAIEmbedder({ apiKey: 'sk', batchSize: -1, fetchImpl: jest.fn() }),
    ).toThrow(/batchSize/);
  });

  it('throws when req.input is not an array', async () => {
    const e = new OpenAIEmbedder({ apiKey: 'sk', fetchImpl: jest.fn() });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(e.embed({ input: null as any })).rejects.toThrow(/must be an array/);
  });
});

describe('MockEmbedder', () => {
  it('default dimension is 1536', () => {
    const m = new MockEmbedder();
    expect(m.dimension).toBe(1536);
  });

  it('returns vectors of the correct length', async () => {
    const m = new MockEmbedder();
    const res = await m.embed({ input: ['hello'] });
    expect(res.vectors).toHaveLength(1);
    expect(res.vectors[0]).toHaveLength(1536);
  });

  it('same input → same vector (deterministic)', async () => {
    const m = new MockEmbedder(64);
    const a = await m.embed({ input: ['foo'] });
    const b = await m.embed({ input: ['foo'] });
    expect(a.vectors[0]).toEqual(b.vectors[0]);
  });

  it('different inputs → different vectors', async () => {
    const m = new MockEmbedder(64);
    const res = await m.embed({ input: ['foo', 'bar'] });
    expect(res.vectors[0]).not.toEqual(res.vectors[1]);
  });

  it('custom dimension is honored', async () => {
    const m = new MockEmbedder(384);
    expect(m.dimension).toBe(384);
    const res = await m.embed({ input: ['x'] });
    expect(res.vectors[0]).toHaveLength(384);
  });

  it('all vector components fall in [-1, 1)', async () => {
    const m = new MockEmbedder(32);
    const res = await m.embed({ input: ['check-bounds'] });
    for (const x of res.vectors[0]) {
      expect(x).toBeGreaterThanOrEqual(-1);
      expect(x).toBeLessThan(1);
    }
  });

  it('tokensUsed is a plausible approximation', async () => {
    const m = new MockEmbedder(16);
    const res = await m.embed({ input: ['abcd', 'abcdefgh'] });
    // ceil(4/4) + ceil(8/4) = 1 + 2 = 3
    expect(res.tokensUsed).toBe(3);
  });

  it('empty input returns empty response', async () => {
    const m = new MockEmbedder(16);
    const res = await m.embed({ input: [] });
    expect(res.vectors).toEqual([]);
    expect(res.tokensUsed).toBe(0);
  });

  it('throws when dimension is not a positive integer', () => {
    expect(() => new MockEmbedder(0)).toThrow(/dimension/);
    expect(() => new MockEmbedder(-5)).toThrow(/dimension/);
    expect(() => new MockEmbedder(1.5)).toThrow(/dimension/);
  });
});
