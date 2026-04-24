/**
 * Minimal HTTPS client for OpenAI embeddings (Phase 11 Wave 3 L10).
 *
 * Why not the `openai` npm package? The CLI tarball ships to every user
 * of `@coderover/mcp`, and we already have one native dep (better-sqlite3)
 * that balloons install size. The `openai` SDK pulls in streaming + tool
 * + moderation + file + assistants surface we don't use, plus transitive
 * deps. Node 18+ has global `fetch`; one POST endpoint is trivial to hit
 * directly.
 *
 * Retry policy is deliberate and narrow:
 *
 *   - 3 attempts total, exponential 500ms / 1500ms / 4500ms.
 *   - Retry on: HTTP 429, 500, 502, 503, 504, or network error
 *     (`TypeError` from fetch, `AbortError` from timeout).
 *   - Do NOT retry on 400/401/403/404 — those are bugs (bad payload,
 *     bad key, revoked key, wrong model) that retrying will never fix.
 *     Surface immediately so users see a useful error.
 *
 * The User-Agent carries the package version so OpenAI-side logs can
 * attribute traffic and we can diagnose "which mcp version is hammering
 * us" without a full header capture. Read at module load via
 * `resolveJsonModule` — safe for TS, no runtime I/O.
 */

// Relative from packages/mcp/src/local/embed/openai-client.ts to the package.json.
// resolveJsonModule is enabled in tsconfig.json.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../../../package.json') as { version: string };

/** Options accepted by {@link OpenAIEmbedClient}. */
export interface OpenAIClientOptions {
  apiKey: string;
  /** Default: `text-embedding-3-small`. */
  model?: string;
  /** Default: `https://api.openai.com/v1`. Trailing slash tolerated. */
  baseUrl?: string;
  /** Default: 30000. Applied per-attempt, not across the whole retry loop. */
  timeoutMs?: number;
  /** Override fetch for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Shape of the subset of OpenAI's `/embeddings` response we consume. */
interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index?: number }>;
  usage?: { total_tokens?: number };
}

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 30_000;

const MAX_ATTEMPTS = 3;
/** Backoff delays in ms, one per *retry*. So 3 attempts => 2 waits. */
const RETRY_DELAYS_MS = [500, 1500, 4500];

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const FATAL_STATUSES = new Set([400, 401, 403, 404]);

export class OpenAIEmbedClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAIClientOptions) {
    if (!opts.apiKey) {
      throw new Error('OpenAIEmbedClient: apiKey is required');
    }
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Node 18+ has global `fetch`. Capture a reference at construction time
    // to keep the call site simple and testable.
    const fallback: typeof fetch | undefined = (globalThis as { fetch?: typeof fetch }).fetch;
    const chosen = opts.fetchImpl ?? fallback;
    if (!chosen) {
      throw new Error(
        'OpenAIEmbedClient: no fetch implementation available. Upgrade to Node 18+ or pass fetchImpl.',
      );
    }
    this.fetchImpl = chosen;
  }

  /**
   * POST `/embeddings` with retry on transient failure. Preserves input
   * order. Returns `{ vectors: [], tokensUsed: 0 }` without hitting the
   * network when `inputs` is empty — avoids a pointless 400 from OpenAI
   * (their API rejects empty arrays).
   */
  async embed(inputs: string[]): Promise<{ vectors: number[][]; tokensUsed: number }> {
    if (inputs.length === 0) {
      return { vectors: [], tokensUsed: 0 };
    }

    const url = `${this.baseUrl}/embeddings`;
    const body = JSON.stringify({ model: this.model, input: inputs });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'User-Agent': `@coderover/mcp/${pkg.version}`,
    };

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const response = await this.fetchWithTimeout(url, { method: 'POST', headers, body });
        if (response.ok) {
          const parsed = (await response.json()) as OpenAIEmbeddingResponse;
          return this.parseResponse(parsed, inputs.length);
        }

        // Read body once for diagnostics; many OpenAI errors carry useful JSON.
        const bodyText = await safeReadBody(response);

        if (FATAL_STATUSES.has(response.status)) {
          throw new Error(
            `OpenAI embeddings request failed (${response.status}): ${bodyText}`,
          );
        }
        if (RETRYABLE_STATUSES.has(response.status)) {
          lastError = new Error(
            `OpenAI embeddings request rate-limited or unavailable (${response.status}): ${bodyText}`,
          );
        } else {
          // Unknown non-2xx status — treat as fatal so we don't silently loop.
          throw new Error(
            `OpenAI embeddings request failed (${response.status}): ${bodyText}`,
          );
        }
      } catch (err: unknown) {
        if (isFatalClientError(err)) {
          throw err;
        }
        lastError = toError(err);
      }

      // If another attempt is coming, wait.
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }

    // All attempts exhausted. Surface a clear message.
    throw new Error(
      `OpenAI embeddings request failed after ${MAX_ATTEMPTS} attempts (rate limited or unavailable): ${
        lastError?.message ?? 'unknown error'
      }`,
    );
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private parseResponse(
    parsed: OpenAIEmbeddingResponse,
    expectedCount: number,
  ): { vectors: number[][]; tokensUsed: number } {
    if (!parsed || !Array.isArray(parsed.data)) {
      throw new Error('OpenAI embeddings response missing `data` array');
    }
    if (parsed.data.length !== expectedCount) {
      throw new Error(
        `OpenAI embeddings response length mismatch: expected ${expectedCount}, got ${parsed.data.length}`,
      );
    }
    // OpenAI does not guarantee `data` order matches input order in principle,
    // but in practice they sort by `index`. Sort defensively if `index` is set.
    const ordered = [...parsed.data];
    if (ordered.every((d) => typeof d.index === 'number')) {
      ordered.sort((a, b) => (a.index as number) - (b.index as number));
    }
    const vectors = ordered.map((d) => d.embedding);
    const tokensUsed = parsed.usage?.total_tokens ?? 0;
    return { vectors, tokensUsed };
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}

/**
 * A thrown error we originated (not from fetch). These are bugs or
 * deliberate fatal signals (400/401/403/404/etc.) and must not be
 * retried. fetch's own failures show up as `TypeError` (network) or
 * `AbortError` (timeout) — both retryable.
 */
function isFatalClientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return false;
  if (err instanceof TypeError) return false;
  // Our own thrown Errors carry this prefix.
  return err.message.startsWith('OpenAI embeddings request failed');
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
