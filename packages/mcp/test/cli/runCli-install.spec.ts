/**
 * Regression tests for the `runCli` install dispatcher.
 *
 * Pre-0.5.1 the dispatch in src/cli/index.ts only forwarded
 * `apiUrl/token/dryRun` to runInstall — `--embed` and `--db-path` were
 * parsed by INSTALL_FLAGS but silently dropped, so the documented
 * `install --local --embed mock` smoke test path actually wrote
 * CODEROVER_EMBED_MODE=openai.
 *
 * These tests exercise the dispatch end-to-end via --dry-run, asserting
 * that the entry printed to stdout reflects the flags the user passed.
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { runCli } from '../../src/cli';

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

async function mkHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'coderover-runcli-'));
}

describe('runCli install --local flag forwarding', () => {
  it('forwards --embed mock through to the dry-run entry', async () => {
    const home = await mkHome();
    const s = captureStreams();
    const code = await runCli(
      [
        'install',
        'claude-code',
        '--local',
        '--embed',
        'mock',
        '--dry-run',
      ],
      { out: s.out, err: s.err, env: {}, cwd: home, homeDir: home },
    );
    expect(code).toBe(0);
    const text = s.outText();
    expect(text).toContain('embed mode: mock');
    expect(text).toContain('"CODEROVER_EMBED_MODE":"mock"');
    // Sanity: no openai-key warning since we explicitly chose mock.
    expect(s.errText()).not.toMatch(/OPENAI_API_KEY/);
  });

  it('forwards --embed offline through to the dry-run entry', async () => {
    const home = await mkHome();
    const s = captureStreams();
    const code = await runCli(
      [
        'install',
        'claude-code',
        '--local',
        '--embed',
        'offline',
        '--dry-run',
      ],
      { out: s.out, err: s.err, env: {}, cwd: home, homeDir: home },
    );
    expect(code).toBe(0);
    expect(s.outText()).toContain('embed mode: offline');
    expect(s.outText()).toContain('"CODEROVER_EMBED_MODE":"offline"');
  });

  it('forwards --embed openai through to the dry-run entry', async () => {
    const home = await mkHome();
    const s = captureStreams();
    const code = await runCli(
      [
        'install',
        'claude-code',
        '--local',
        '--embed',
        'openai',
        '--dry-run',
      ],
      {
        out: s.out,
        err: s.err,
        // Set the key so the install path doesn't print the
        // OPENAI_API_KEY-missing warning, keeping this test focused on
        // the flag-forwarding contract.
        env: { OPENAI_API_KEY: 'sk-test-noop' },
        cwd: home,
        homeDir: home,
      },
    );
    expect(code).toBe(0);
    expect(s.outText()).toContain('embed mode: openai');
    expect(s.outText()).toContain('"CODEROVER_EMBED_MODE":"openai"');
  });

  it('warns when --embed is passed in remote mode', async () => {
    const home = await mkHome();
    const s = captureStreams();
    const code = await runCli(
      [
        'install',
        'claude-code',
        '--remote',
        '--embed',
        'mock',
        '--api-url',
        'https://x',
        '--token',
        't',
        '--dry-run',
      ],
      { out: s.out, err: s.err, env: {}, cwd: home, homeDir: home },
    );
    expect(code).toBe(0);
    expect(s.errText()).toContain(
      '--embed has no effect in remote mode',
    );
  });

  it('rejects an unknown --embed value with a clean error', async () => {
    const home = await mkHome();
    const s = captureStreams();
    const code = await runCli(
      [
        'install',
        'claude-code',
        '--local',
        '--embed',
        'bogus',
        '--dry-run',
      ],
      { out: s.out, err: s.err, env: {}, cwd: home, homeDir: home },
    );
    expect(code).toBe(1);
    expect(s.errText()).toContain(
      '--embed requires mock|openai|offline, got bogus',
    );
  });

  it('forwards --db-path through to the dry-run entry', async () => {
    const home = await mkHome();
    const customDb = path.join(home, 'custom-index.db');
    const s = captureStreams();
    const code = await runCli(
      [
        'install',
        'claude-code',
        '--local',
        '--embed',
        'mock',
        '--db-path',
        customDb,
        '--dry-run',
      ],
      { out: s.out, err: s.err, env: {}, cwd: home, homeDir: home },
    );
    expect(code).toBe(0);
    const text = s.outText();
    expect(text).toContain(`DB path: ${customDb}`);
    expect(text).toContain(`"CODEROVER_LOCAL_DB":"${customDb}"`);
  });
});
