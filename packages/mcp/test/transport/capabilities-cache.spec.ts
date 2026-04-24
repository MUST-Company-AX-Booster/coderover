import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CapabilitiesCache } from '../../src/transport/capabilities-cache';
import type { BackendCapabilities, McpTool } from '../../src/protocol';

async function mkHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'coderover-cache-'));
}

const CAPS: BackendCapabilities = {
  version: '0.9.1',
  tools: ['search_code', 'find_symbol'],
  features: { confidence_tags: true, incremental_cache: false },
};

const TOOLS: McpTool[] = [
  {
    name: 'search_code',
    description: 'Search code semantically',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

describe('CapabilitiesCache', () => {
  it('returns null for a cache miss', async () => {
    const home = await mkHome();
    const cache = new CapabilitiesCache({ homeDir: home });
    expect(cache.read('https://api.example.com')).toBeNull();
  });

  it('round-trips capabilities + tools', async () => {
    const home = await mkHome();
    const cache = new CapabilitiesCache({
      homeDir: home,
      packageVersion: '0.3.0',
      now: () => 1000,
    });
    cache.write('https://api.example.com', {
      capabilities: CAPS,
      tools: TOOLS,
    });
    const got = cache.read('https://api.example.com');
    expect(got).toEqual({
      apiUrl: 'https://api.example.com',
      capabilities: CAPS,
      tools: TOOLS,
      fetchedAt: 1000,
      writtenBy: '0.3.0',
    });
  });

  it('write() preserves the other slice on partial updates', async () => {
    const home = await mkHome();
    const cache = new CapabilitiesCache({ homeDir: home, now: () => 1 });
    cache.write('https://x', { capabilities: CAPS });
    cache.write('https://x', { tools: TOOLS });
    const got = cache.read('https://x');
    expect(got?.capabilities).toEqual(CAPS);
    expect(got?.tools).toEqual(TOOLS);
  });

  it('normalizes trailing slashes — same cache entry', async () => {
    const home = await mkHome();
    const cache = new CapabilitiesCache({ homeDir: home, now: () => 1 });
    cache.write('https://foo.com///', { capabilities: CAPS });
    expect(cache.read('https://foo.com')).toBeTruthy();
    // Both URLs produce the same path.
    expect(cache.pathFor('https://foo.com')).toBe(
      cache.pathFor('https://foo.com/'),
    );
  });

  it('different URLs land in different files', async () => {
    const home = await mkHome();
    const cache = new CapabilitiesCache({ homeDir: home });
    const a = cache.pathFor('https://a.example.com');
    const b = cache.pathFor('https://b.example.com');
    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe(path.join(home, '.coderover'));
  });

  it('treats malformed JSON as a miss', async () => {
    const home = await mkHome();
    const cache = new CapabilitiesCache({ homeDir: home });
    const p = cache.pathFor('https://x');
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, '{not-json');
    expect(cache.read('https://x')).toBeNull();
  });

  it('treats apiUrl mismatch (hash collision guard) as a miss', async () => {
    const home = await mkHome();
    const cache = new CapabilitiesCache({ homeDir: home });
    const p = cache.pathFor('https://real.example.com');
    await fs.mkdir(path.dirname(p), { recursive: true });
    // Write a sidecar whose inner apiUrl is wrong.
    await fs.writeFile(
      p,
      JSON.stringify({
        apiUrl: 'https://different.example.com',
        capabilities: CAPS,
        tools: TOOLS,
        fetchedAt: 1,
        writtenBy: 'x',
      }),
    );
    expect(cache.read('https://real.example.com')).toBeNull();
  });

  it('clear() removes the cache and is idempotent', async () => {
    const home = await mkHome();
    const cache = new CapabilitiesCache({ homeDir: home });
    cache.write('https://x', { capabilities: CAPS, tools: TOOLS });
    cache.clear('https://x');
    expect(cache.read('https://x')).toBeNull();
    // Second call must not throw.
    cache.clear('https://x');
  });
});
