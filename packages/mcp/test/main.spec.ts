/**
 * Boot-path tests for the public `main()` entry.
 *
 * Two layers of coverage:
 *
 *   1. `resolveServerMode` — pure mode-dispatch logic. Fast unit tests.
 *   2. End-to-end subprocess spawn of `bin/coderover-mcp.js` in
 *      `CODEROVER_MODE=local`, seeding a real (but empty) SQLite index
 *      via `openIndexedDb` and sending an MCP `initialize` +
 *      `tools/list` over stdio. Guards against regressions like the
 *      0.2.1 bug where `main()` unconditionally boots remote and
 *      rejects local-mode env.
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveServerMode } from '../src/index';
import { openIndexedDb } from '../src/cli/local/shared';

describe('resolveServerMode', () => {
  const savedMode = process.env.CODEROVER_MODE;
  afterEach(() => {
    if (savedMode === undefined) {
      delete process.env.CODEROVER_MODE;
    } else {
      process.env.CODEROVER_MODE = savedMode;
    }
  });

  it('returns "remote" by default', () => {
    delete process.env.CODEROVER_MODE;
    expect(resolveServerMode()).toBe('remote');
  });

  it('returns "local" when CODEROVER_MODE=local', () => {
    process.env.CODEROVER_MODE = 'local';
    expect(resolveServerMode()).toBe('local');
  });

  it('is case-insensitive and whitespace-tolerant', () => {
    process.env.CODEROVER_MODE = '  LOCAL  ';
    expect(resolveServerMode()).toBe('local');
  });

  it('treats unknown values as remote (fail-open to the default)', () => {
    process.env.CODEROVER_MODE = 'hybrid';
    expect(resolveServerMode()).toBe('remote');
  });

  it('prefers the explicit opts.mode over the env', () => {
    process.env.CODEROVER_MODE = 'local';
    expect(resolveServerMode({ mode: 'remote' })).toBe('remote');
  });
});

describe('main() — local-mode boot (subprocess)', () => {
  const BIN = path.resolve(__dirname, '..', 'bin', 'coderover-mcp.js');
  let tmpDir: string;
  let dbPath: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coderover-main-'));
    dbPath = path.join(tmpDir, 'index.db');
    // Seed an empty-but-migrated DB at the default OpenAI dim so the
    // MockEmbedder (same dim) can open it without a dim-mismatch error.
    const db = await openIndexedDb(dbPath);
    db.close();
  });

  afterAll(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  /**
   * Spawn the bin, feed it `requests` on stdin (one JSON-RPC frame
   * per line), collect stdout frames, and return them.
   *
   * Resolves when we have read `expectedResponses` frames or the child
   * exits. Kills the child after so the test never hangs.
   */
  async function runBinWithMessages(
    env: NodeJS.ProcessEnv,
    requests: string[],
    expectedResponses: number,
    timeoutMs = 10_000,
  ): Promise<{ frames: unknown[]; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN], {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const frames: unknown[] = [];
      let stdoutBuf = '';
      let stderr = '';
      let settled = false;

      const finish = (code: number | null): void => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* already dead */
        }
        resolve({ frames, stderr, code });
      };

      const timer = setTimeout(() => {
        finish(null);
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            frames.push(JSON.parse(trimmed));
          } catch {
            /* skip non-JSON diagnostic lines */
          }
        }
        if (frames.length >= expectedResponses) {
          clearTimeout(timer);
          finish(0);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        clearTimeout(timer);
        finish(code);
      });

      for (const req of requests) {
        child.stdin.write(req + '\n');
      }
    });
  }

  it('exits 2 with a helpful message when CODEROVER_LOCAL_DB is missing', async () => {
    const res = await runBinWithMessages(
      {
        CODEROVER_MODE: 'local',
        CODEROVER_LOCAL_DB: '',
        CODEROVER_EMBED_MODE: 'mock',
      },
      [],
      0,
      5_000,
    );
    expect(res.stderr).toContain('CODEROVER_LOCAL_DB is required');
    expect(res.code).toBe(2);
  });

  it('boots LocalTransport and answers tools/list over stdio', async () => {
    const init = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'main-spec', version: '0.0.1' },
      },
    });
    const initialized = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    const toolsList = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    const res = await runBinWithMessages(
      {
        CODEROVER_MODE: 'local',
        CODEROVER_LOCAL_DB: dbPath,
        CODEROVER_EMBED_MODE: 'mock',
      },
      [init, initialized, toolsList],
      2,
      15_000,
    );

    // Two id-bearing responses: initialize + tools/list. The
    // initialized notification has no id and gets no response.
    const initResp = res.frames.find(
      (f): f is { id: number; result: unknown } =>
        typeof f === 'object' &&
        f !== null &&
        (f as { id?: number }).id === 1,
    );
    const listResp = res.frames.find(
      (f): f is {
        id: number;
        result: { tools: Array<{ name: string }> };
      } =>
        typeof f === 'object' &&
        f !== null &&
        (f as { id?: number }).id === 2,
    );

    expect(initResp).toBeDefined();
    expect(listResp).toBeDefined();
    expect(listResp!.result.tools.map((t) => t.name).sort()).toEqual([
      'find_dependencies',
      'find_symbol',
      'search_code',
    ]);
    expect(res.stderr).not.toContain('CODEROVER_API_URL is required');
  });
});
