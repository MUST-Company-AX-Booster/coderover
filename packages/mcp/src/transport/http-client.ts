/**
 * Tiny HTTP client abstraction so RemoteTransport is trivially mockable in
 * Jest. Wraps `fetch` (Node 18+) and injects auth headers.
 */

export interface HttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface HttpClient {
  request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<HttpResponse>;
}

export interface HttpClientOptions {
  baseUrl: string;
  token?: string;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms. Default 30s. */
  timeoutMs?: number;
}

export class FetchHttpClient implements HttpClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: HttpClientOptions) {
    // Strip trailing slash so we can always concat with an absolute path.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? (globalThis as any).fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;

    if (typeof this.fetchImpl !== 'function') {
      throw new Error(
        'No fetch implementation available. Node >= 18.17 required, or pass fetchImpl.',
      );
    }
  }

  async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<HttpResponse> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        text: () => res.text(),
        json: () => res.json(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`HTTP ${method} ${url} failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
