/**
 * `coderover index` CLI tests — Phase 11 Wave 4 L17.
 *
 * Exercises `parseIndexArgs` + `runIndexCmd`. The runtime tests inject
 * an in-tmpdir DB path and a MockEmbedder so nothing touches $HOME or
 * the network.
 *
 * Full-pipeline tests are gated on `TS_REAL=1` because `indexRepo`
 * walks real source via tree-sitter.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';

import {
  parseIndexArgs,
  runIndexCmd,
  helpText,
} from '../../../src/cli/local/index-cmd';
import { openIndexedDb } from '../../../src/cli/local/shared';
import { MockEmbedder } from '../../../src/local/embed/embedder';
import { treeSitterAvailable } from '../../helpers/tree-sitter-singleton';

function captureStreams() {
  const out = new PassThrough();
  const err = new PassThrough();
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  out.on('data', (c: Buffer) => outChunks.push(c.toString()));
  err.on('data', (c: Buffer) => errChunks.push(c.toString()));
  return {
    out,
    err,
    outText: (): string => outChunks.join(''),
    errText: (): string => errChunks.join(''),
  };
}

function seedRepo(
  files: Record<string, string>,
): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-index-repo-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  // Add a package.json so resolveProjectRoot lands on our tmpdir.
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"tmp"}', 'utf8');
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function mkTmpDbPath(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-index-db-'));
  return {
    dbPath: path.join(dir, 'local.db'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe('parseIndexArgs', () => {
  it('parses a positional path', () => {
    expect(parseIndexArgs(['/tmp/foo'])).toEqual({ path: '/tmp/foo' });
  });

  it('parses --verbose', () => {
    expect(parseIndexArgs(['--verbose'])).toEqual({ verbose: true });
  });

  it('parses --embed mock and --embed openai', () => {
    expect(parseIndexArgs(['--embed', 'mock'])).toEqual({ embed: 'mock' });
    expect(parseIndexArgs(['--embed=openai'])).toEqual({ embed: 'openai' });
  });

  it('surfaces unknown flags', () => {
    const args = parseIndexArgs(['--bogus']);
    expect(args.unknown).toMatch(/unknown flag/);
  });

  it('rejects a bad --embed value', () => {
    const args = parseIndexArgs(['--embed', 'invalid']);
    expect(args.unknown).toMatch(/--embed requires/);
  });

  it('accepts --help', () => {
    expect(parseIndexArgs(['--help'])).toEqual({ help: true });
    expect(parseIndexArgs(['-h'])).toEqual({ help: true });
  });
});

describe('runIndexCmd — help and errors', () => {
  it('--help prints banner and returns 0', async () => {
    const streams = captureStreams();
    const code = await runIndexCmd(['--help'], {
      stdout: streams.out,
      stderr: streams.err,
    });
    expect(code).toBe(0);
    expect(streams.outText()).toBe(helpText());
  });

  it('unknown flag returns exit 2', async () => {
    const streams = captureStreams();
    const code = await runIndexCmd(['--nope'], {
      stdout: streams.out,
      stderr: streams.err,
    });
    expect(code).toBe(2);
    expect(streams.errText()).toMatch(/unknown flag/);
  });
});

const describeIfTs = treeSitterAvailable() ? describe : describe.skip;

describeIfTs('runIndexCmd — pipeline (real tree-sitter)', () => {
  it('indexes a seeded repo and returns exit 0', async () => {
    const { root, cleanup: rmRoot } = seedRepo({
      'src/a.ts': 'export function alpha(){ return 1 }\n',
      'src/b.ts': 'export function beta(){ return 2 }\n',
    });
    const { dbPath, cleanup: rmDb } = mkTmpDbPath();
    const streams = captureStreams();
    try {
      const code = await runIndexCmd([root, '--embed', 'mock'], {
        stdout: streams.out,
        stderr: streams.err,
        resolveDbPath: () => dbPath,
        resolveProjectRoot: (x) => x ?? root,
        buildEmbedder: () => new MockEmbedder(),
        openIndexedDb,
      });
      expect(code).toBe(0);
      const txt = streams.outText();
      expect(txt).toMatch(/files/);
      expect(txt).toMatch(/indexed/);
      expect(txt).toMatch(/skipped/);

      // DB exists + has rows.
      expect(fs.existsSync(dbPath)).toBe(true);
    } finally {
      rmDb();
      rmRoot();
    }
  });

  it('subsequent index skips all files', async () => {
    const { root, cleanup: rmRoot } = seedRepo({
      'src/a.ts': 'export function alpha(){ return 1 }\n',
      'src/b.ts': 'export function beta(){ return 2 }\n',
    });
    const { dbPath, cleanup: rmDb } = mkTmpDbPath();
    try {
      const first = captureStreams();
      await runIndexCmd([root, '--embed', 'mock'], {
        stdout: first.out,
        stderr: first.err,
        resolveDbPath: () => dbPath,
        resolveProjectRoot: (x) => x ?? root,
        buildEmbedder: () => new MockEmbedder(),
        openIndexedDb,
      });

      const second = captureStreams();
      const code = await runIndexCmd([root, '--embed', 'mock'], {
        stdout: second.out,
        stderr: second.err,
        resolveDbPath: () => dbPath,
        resolveProjectRoot: (x) => x ?? root,
        buildEmbedder: () => new MockEmbedder(),
        openIndexedDb,
      });
      expect(code).toBe(0);
      const txt = second.outText();
      // Look for "indexed    0" and "skipped    2" in the table.
      expect(txt).toMatch(/indexed\s+0/);
      expect(txt).toMatch(/skipped\s+2/);
    } finally {
      rmDb();
      rmRoot();
    }
  });
});
