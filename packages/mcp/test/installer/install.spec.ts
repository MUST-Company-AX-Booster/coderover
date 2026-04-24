/**
 * End-to-end install flow tests.
 *
 * These tests exercise `runInstall` with real tmpdir-based agent adapters
 * and a stubbed HTTP factory — no network, no real $HOME pollution.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { runInstall, buildTokenMintUrl } from '../../src/cli/install';
import type {
  HttpClient,
  HttpResponse,
} from '../../src/transport/http-client';
import type { PromptIo } from '../../src/cli/prompt';

async function mkHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'coderover-install-'));
}

function captureStreams() {
  const out = new PassThrough();
  const err = new PassThrough();
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  out.on('data', (c) => outChunks.push(c.toString()));
  err.on('data', (c) => errChunks.push(c.toString()));
  return {
    out,
    err,
    outText: () => outChunks.join(''),
    errText: () => errChunks.join(''),
  };
}

function noTtyIo(): PromptIo {
  return {
    input: new PassThrough(),
    output: new PassThrough(),
    isTTY: false,
  };
}

function makeHttpThatAlways404s(): (opts: {
  baseUrl: string;
  token?: string;
}) => HttpClient {
  return () => ({
    async request(
      _method: 'GET' | 'POST',
      _path: string,
    ): Promise<HttpResponse> {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => '',
        json: async () => ({}),
      };
    },
  });
}

describe('runInstall', () => {
  it('requires at least one agent', async () => {
    const home = await mkHome();
    const s = captureStreams();
    const res = await runInstall(
      {
        agents: [],
        mode: 'remote',
        apiUrl: 'https://x',
        token: 't',
        dryRun: false,
      },
      {
        io: noTtyIo(),
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        cwd: home,
      },
    );
    expect(res.exitCode).toBe(1);
    expect(s.errText()).toMatch(/at least one/);
  });

  it('rejects unknown agent names', async () => {
    const home = await mkHome();
    const s = captureStreams();
    const res = await runInstall(
      {
        agents: ['notanagent'],
        mode: 'remote',
        apiUrl: 'https://x',
        token: 't',
        dryRun: false,
      },
      {
        io: noTtyIo(),
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        cwd: home,
      },
    );
    expect(res.exitCode).toBe(1);
    expect(s.errText()).toMatch(/unknown agent/);
  });

  it('fails non-TTY without --api-url', async () => {
    const home = await mkHome();
    const s = captureStreams();
    const res = await runInstall(
      {
        agents: ['claude-code'],
        mode: 'remote',
        token: 't',
        dryRun: false,
      },
      {
        io: noTtyIo(),
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        cwd: home,
      },
    );
    expect(res.exitCode).toBe(1);
    expect(s.errText()).toMatch(/missing --api-url/);
  });

  it('fails non-TTY without --token', async () => {
    const home = await mkHome();
    const s = captureStreams();
    const res = await runInstall(
      {
        agents: ['claude-code'],
        mode: 'remote',
        apiUrl: 'https://x',
        dryRun: false,
      },
      {
        io: noTtyIo(),
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        cwd: home,
      },
    );
    expect(res.exitCode).toBe(1);
    expect(s.errText()).toMatch(/missing --token/);
  });

  it('honors CODEROVER_API_URL + CODEROVER_API_TOKEN env vars', async () => {
    const home = await mkHome();
    const s = captureStreams();
    const res = await runInstall(
      { agents: ['claude-code'], mode: 'remote', dryRun: false },
      {
        io: noTtyIo(),
        out: s.out,
        err: s.err,
        env: {
          CODEROVER_API_URL: 'https://env.example',
          CODEROVER_API_TOKEN: 'env_tok',
        },
        homeDir: home,
        cwd: home,
        makeHttp: makeHttpThatAlways404s(),
      },
    );
    expect(res.exitCode).toBe(0);
    const configPath = path.join(home, '.claude', 'config.json');
    const doc = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(doc.mcpServers.coderover.env.CODEROVER_API_URL).toBe(
      'https://env.example',
    );
    expect(doc.mcpServers.coderover.env.CODEROVER_API_TOKEN).toBe('env_tok');
  });

  it('writes configs for multiple agents in one shot', async () => {
    const home = await mkHome();
    const s = captureStreams();
    const res = await runInstall(
      {
        agents: ['claude-code', 'cursor', 'aider'],
        mode: 'remote',
        apiUrl: 'https://multi.example',
        token: 'multi_tok',
        dryRun: false,
      },
      {
        io: noTtyIo(),
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        cwd: home,
        makeHttp: makeHttpThatAlways404s(),
      },
    );
    expect(res.exitCode).toBe(0);
    await fs.access(path.join(home, '.claude', 'config.json'));
    await fs.access(path.join(home, '.cursor', 'mcp.json'));
    await fs.access(path.join(home, '.aider.conf.yml'));
  });

  it('pins the packageVersion into the npx arg (remote mode)', async () => {
    const home = await mkHome();
    const s = captureStreams();
    const res = await runInstall(
      {
        agents: ['claude-code'],
        mode: 'remote',
        apiUrl: 'https://x',
        token: 't',
        dryRun: false,
      },
      {
        io: noTtyIo(),
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        cwd: home,
        makeHttp: makeHttpThatAlways404s(),
        packageVersion: '9.9.9',
      },
    );
    expect(res.exitCode).toBe(0);
    const doc = JSON.parse(
      await fs.readFile(path.join(home, '.claude', 'config.json'), 'utf8'),
    );
    expect(doc.mcpServers.coderover.args).toEqual(['@coderover/mcp@9.9.9']);
  });

  it('pins the packageVersion into the npx arg (local mode)', async () => {
    const home = await mkHome();
    const s = captureStreams();
    const res = await runInstall(
      {
        agents: ['claude-code'],
        mode: 'local',
        embedMode: 'mock',
        dryRun: false,
      },
      {
        io: noTtyIo(),
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        cwd: home,
        packageVersion: '9.9.9',
      },
    );
    expect(res.exitCode).toBe(0);
    const doc = JSON.parse(
      await fs.readFile(path.join(home, '.claude', 'config.json'), 'utf8'),
    );
    expect(doc.mcpServers.coderover.args).toEqual(['@coderover/mcp@9.9.9']);
  });

  it('falls back to @latest when no packageVersion is provided (legacy callers)', async () => {
    const home = await mkHome();
    const s = captureStreams();
    const res = await runInstall(
      {
        agents: ['claude-code'],
        mode: 'remote',
        apiUrl: 'https://x',
        token: 't',
        dryRun: false,
      },
      {
        io: noTtyIo(),
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        cwd: home,
        makeHttp: makeHttpThatAlways404s(),
      },
    );
    expect(res.exitCode).toBe(0);
    const doc = JSON.parse(
      await fs.readFile(path.join(home, '.claude', 'config.json'), 'utf8'),
    );
    expect(doc.mcpServers.coderover.args).toEqual(['@coderover/mcp@latest']);
  });

  it('dry-run writes nothing to disk but prints a plan', async () => {
    const home = await mkHome();
    const s = captureStreams();
    const res = await runInstall(
      {
        agents: ['claude-code'],
        mode: 'remote',
        apiUrl: 'https://x',
        token: 't',
        dryRun: true,
      },
      {
        io: noTtyIo(),
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        cwd: home,
      },
    );
    expect(res.exitCode).toBe(0);
    expect(s.outText()).toMatch(/dry-run/);
    await expect(
      fs.access(path.join(home, '.claude', 'config.json')),
    ).rejects.toThrow();
  });

  it('--local writes an entry with CODEROVER_MODE=local', async () => {
    const home = await mkHome();
    const s = captureStreams();
    const res = await runInstall(
      {
        agents: ['claude-code'],
        mode: 'local',
        embedMode: 'mock',
        dryRun: false,
      },
      {
        io: noTtyIo(),
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        cwd: home,
      },
    );
    expect(res.exitCode).toBe(0);
    const configPath = path.join(home, '.claude', 'config.json');
    const doc = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(doc.mcpServers.coderover.env.CODEROVER_MODE).toBe('local');
    expect(doc.mcpServers.coderover.env.CODEROVER_EMBED_MODE).toBe('mock');
    // default db path should live under <home>/.coderover/<sha>.db
    expect(doc.mcpServers.coderover.env.CODEROVER_LOCAL_DB).toMatch(
      new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.coderover/.*\\.db$`),
    );
  });

  it('--local honors --db-path override', async () => {
    const home = await mkHome();
    const s = captureStreams();
    const res = await runInstall(
      {
        agents: ['claude-code'],
        mode: 'local',
        dbPath: '/custom/path.db',
        embedMode: 'mock',
        dryRun: false,
      },
      {
        io: noTtyIo(),
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        cwd: home,
      },
    );
    expect(res.exitCode).toBe(0);
    const configPath = path.join(home, '.claude', 'config.json');
    const doc = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(doc.mcpServers.coderover.env.CODEROVER_LOCAL_DB).toBe(
      '/custom/path.db',
    );
  });

  it('--local --embed mock propagates CODEROVER_EMBED_MODE=mock', async () => {
    const home = await mkHome();
    const s = captureStreams();
    await runInstall(
      {
        agents: ['claude-code'],
        mode: 'local',
        embedMode: 'mock',
        dryRun: false,
      },
      {
        io: noTtyIo(),
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        cwd: home,
      },
    );
    const configPath = path.join(home, '.claude', 'config.json');
    const doc = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(doc.mcpServers.coderover.env.CODEROVER_EMBED_MODE).toBe('mock');
  });

  it('--local warns when embed=openai and OPENAI_API_KEY is unset', async () => {
    const home = await mkHome();
    const s = captureStreams();
    const res = await runInstall(
      {
        agents: ['claude-code'],
        mode: 'local',
        embedMode: 'openai',
        dryRun: false,
      },
      {
        io: noTtyIo(),
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        cwd: home,
      },
    );
    expect(res.exitCode).toBe(0);
    expect(s.errText()).toMatch(/OPENAI_API_KEY/);
  });

  it('remote mode is unchanged — CODEROVER_MODE is NOT written', async () => {
    // regression guard: make sure --local plumbing didn't leak into remote.
    const home = await mkHome();
    const s = captureStreams();
    const res = await runInstall(
      {
        agents: ['claude-code'],
        mode: 'remote',
        apiUrl: 'https://x',
        token: 't',
        dryRun: false,
      },
      {
        io: noTtyIo(),
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        cwd: home,
        makeHttp: makeHttpThatAlways404s(),
      },
    );
    expect(res.exitCode).toBe(0);
    const configPath = path.join(home, '.claude', 'config.json');
    const doc = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(doc.mcpServers.coderover.env.CODEROVER_MODE).toBeUndefined();
    expect(doc.mcpServers.coderover.env.CODEROVER_LOCAL_DB).toBeUndefined();
    expect(doc.mcpServers.coderover.env.CODEROVER_API_URL).toBe('https://x');
  });

  it('--local dry-run prints plan but writes nothing', async () => {
    const home = await mkHome();
    const s = captureStreams();
    const res = await runInstall(
      {
        agents: ['claude-code'],
        mode: 'local',
        embedMode: 'mock',
        dryRun: true,
      },
      {
        io: noTtyIo(),
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        cwd: home,
      },
    );
    expect(res.exitCode).toBe(0);
    expect(s.outText()).toMatch(/dry-run/);
    expect(s.outText()).toMatch(/local-mode/);
    await expect(
      fs.access(path.join(home, '.claude', 'config.json')),
    ).rejects.toThrow();
  });

  it('prints the first-prompt suggestion on success', async () => {
    const home = await mkHome();
    const s = captureStreams();
    await runInstall(
      {
        agents: ['claude-code'],
        mode: 'remote',
        apiUrl: 'https://x',
        token: 't',
        dryRun: false,
      },
      {
        io: noTtyIo(),
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        cwd: home,
        makeHttp: makeHttpThatAlways404s(),
      },
    );
    expect(s.outText()).toMatch(/Walk me through how auth works/);
  });

  it('ingest 404 does not fail install and prints a dashboard hint', async () => {
    const home = await mkHome();
    const s = captureStreams();

    // Simulate a TTY so the ingest prompt returns "yes" (default).
    const io: PromptIo = {
      input: new PassThrough(),
      output: new PassThrough(),
      isTTY: false, // askYesNo with non-TTY returns `defaultYes`; same outcome, simpler
    };
    const res = await runInstall(
      {
        agents: ['claude-code'],
        mode: 'remote',
        apiUrl: 'https://x',
        token: 't',
        dryRun: false,
      },
      {
        io,
        out: s.out,
        err: s.err,
        env: {},
        homeDir: home,
        cwd: home,
        makeHttp: makeHttpThatAlways404s(),
      },
    );
    expect(res.exitCode).toBe(0);
    expect(s.outText()).toMatch(/dashboard/);
  });
});

describe('buildTokenMintUrl', () => {
  it('builds a scoped token mint URL with the agent label', () => {
    const url = buildTokenMintUrl('https://api.example.com/', 'claude-code');
    expect(url).toContain('/auth/tokens/new');
    expect(url).toContain('scope=search%3Aread%2Cgraph%3Aread%2Ccitations%3Aread');
    expect(url).toContain('label=claude-code');
    expect(url).not.toMatch(/\/\/auth/); // trailing slash got stripped
  });
});
