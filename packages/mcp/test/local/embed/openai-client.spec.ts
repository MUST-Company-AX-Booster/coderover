/**
 * Tests for Phase 11 Wave 3 L10 — `openai-client.ts`.
 *
 * All tests inject a mock `fetchImpl`. No real network. The retry loop
 * uses real timers with 500/1500/4500 ms backoffs, so tests that
 * exercise multiple attempts use Jest fake timers to advance the clock
 * instead of actually sleeping.
 */

import { OpenAIEmbedClient } from '../../../src/local/embed/openai-client';

// Package version (read by the client for the User-Agent header).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../../../package.json') as { version: string };

// ─── helpers ────────────────────────────────────────────────────────────────

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

/**
 * Drive the retry loop forward past its backoff `setTimeout` calls when
 * fake timers are installed. Each call advances enough ms to cover the
 * longest delay (4500). Safe to call redundantly.
 */
async function flushRetries(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    // advanceTimersByTimeAsync drains microtasks between timer ticks so
    // the awaited fetch settles before we advance past the next setTimeout.
    await jest.advanceTimersByTimeAsync(5000);
  }
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('OpenAIEmbedClient', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('happy path: returns vectors and tokensUsed', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(200, okEmbedBody([[0.1, 0.2], [0.3, 0.4]], 42)),
    );
    const client = new OpenAIEmbedClient({ apiKey: 'sk-test', fetchImpl });

    const result = await client.embed(['hello', 'world']);

    expect(result.vectors).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(result.tokensUsed).toBe(42);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.input).toEqual(['hello', 'world']);
    expect(body.model).toBe('text-embedding-3-small');
  });

  it('sets User-Agent header with package version', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, okEmbedBody([[1]], 1)));
    const client = new OpenAIEmbedClient({ apiKey: 'sk-test', fetchImpl });
    await client.embed(['x']);
    const headers = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(`@coderover/mcp/${pkg.version}`);
    expect(headers['Authorization']).toBe('Bearer sk-test');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('429 then 200: retries once, succeeds', async () => {
    jest.useFakeTimers();
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: 'rate limit' } }))
      .mockResolvedValueOnce(jsonResponse(200, okEmbedBody([[0.5]], 3)));
    const client = new OpenAIEmbedClient({ apiKey: 'sk-test', fetchImpl });

    const p = client.embed(['hi']);
    await flushRetries(1);
    const result = await p;

    expect(result.vectors).toEqual([[0.5]]);
    expect(result.tokensUsed).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('429 → 429 → 200: retries twice, succeeds', async () => {
    jest.useFakeTimers();
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: 'rate' } }))
      .mockResolvedValueOnce(jsonResponse(503, { error: { message: 'busy' } }))
      .mockResolvedValueOnce(jsonResponse(200, okEmbedBody([[0.9]], 7)));
    const client = new OpenAIEmbedClient({ apiKey: 'sk-test', fetchImpl });

    const p = client.embed(['q']);
    await flushRetries(2);
    const result = await p;

    expect(result.vectors).toEqual([[0.9]]);
    expect(result.tokensUsed).toBe(7);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('429 × 3: throws a clear rate-limited error after 3 attempts', async () => {
    jest.useFakeTimers();
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(429, { error: { message: 'throttled' } }));
    const client = new OpenAIEmbedClient({ apiKey: 'sk-test', fetchImpl });

    const p = client.embed(['q']);
    // Swallow the rejection on `p` so the scheduler doesn't log it
    // while we're still advancing timers.
    const assertion = expect(p).rejects.toThrow(/after 3 attempts/i);
    await flushRetries(3);
    await assertion;

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('400: throws immediately with body text, no retry', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(400, { error: { message: 'bad input' } }));
    const client = new OpenAIEmbedClient({ apiKey: 'sk-test', fetchImpl });

    await expect(client.embed(['q'])).rejects.toThrow(/400.*bad input/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('401: throws immediately (auth error), no retry', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(401, { error: { message: 'invalid key' } }));
    const client = new OpenAIEmbedClient({ apiKey: 'sk-bad', fetchImpl });

    await expect(client.embed(['q'])).rejects.toThrow(/401.*invalid key/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('403 and 404: throw immediately, no retry', async () => {
    const fetch403 = jest
      .fn()
      .mockResolvedValue(jsonResponse(403, { error: { message: 'forbidden' } }));
    const fetch404 = jest
      .fn()
      .mockResolvedValue(jsonResponse(404, { error: { message: 'not found' } }));
    const c403 = new OpenAIEmbedClient({ apiKey: 'sk', fetchImpl: fetch403 });
    const c404 = new OpenAIEmbedClient({ apiKey: 'sk', fetchImpl: fetch404 });

    await expect(c403.embed(['q'])).rejects.toThrow(/403/);
    await expect(c404.embed(['q'])).rejects.toThrow(/404/);
    expect(fetch403).toHaveBeenCalledTimes(1);
    expect(fetch404).toHaveBeenCalledTimes(1);
  });

  it('network error (TypeError): retries', async () => {
    jest.useFakeTimers();
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(200, okEmbedBody([[0.2]], 1)));
    const client = new OpenAIEmbedClient({ apiKey: 'sk', fetchImpl });

    const p = client.embed(['q']);
    await flushRetries(1);
    const result = await p;

    expect(result.vectors).toEqual([[0.2]]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('timeout: AbortController fires, then retry succeeds', async () => {
    jest.useFakeTimers();
    // First call: respect the AbortSignal and reject with AbortError.
    // Second call: succeed.
    const fetchImpl = jest.fn(async (_url: unknown, init: unknown) => {
      const signal = (init as { signal?: AbortSignal }).signal;
      if (fetchImpl.mock.calls.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      return jsonResponse(200, okEmbedBody([[0.7]], 2));
    });
    const client = new OpenAIEmbedClient({
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 100,
    });

    const p = client.embed(['q']);
    // Let the first fetch start, then trigger the timeout.
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(100);
    // Then let the backoff elapse.
    await flushRetries(1);
    const result = await p;

    expect(result.vectors).toEqual([[0.7]]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('empty inputs: returns empty result without calling fetch', async () => {
    const fetchImpl = jest.fn();
    const client = new OpenAIEmbedClient({ apiKey: 'sk', fetchImpl });
    const result = await client.embed([]);
    expect(result).toEqual({ vectors: [], tokensUsed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('constructor: apiKey required', () => {
    expect(() => new OpenAIEmbedClient({ apiKey: '' })).toThrow(/apiKey/);
  });

  it('baseUrl: trailing slashes are stripped', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, okEmbedBody([[1]], 1)));
    const client = new OpenAIEmbedClient({
      apiKey: 'sk',
      baseUrl: 'https://proxy.example.com/v1/',
      fetchImpl,
    });
    await client.embed(['x']);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://proxy.example.com/v1/embeddings');
  });
});
