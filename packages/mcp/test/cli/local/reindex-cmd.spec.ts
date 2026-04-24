/**
 * `coderover reindex` CLI tests — Phase 11 Wave 4 L17.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';

import {
  runReindexCmd,
  helpText,
} from '../../../src/cli/local/reindex-cmd';
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

function seedRepo(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-reindex-repo-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"tmp"}', 'utf8');
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function mkTmpDbPath(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-reindex-db-'));
  return {
    dbPath: path.join(dir, 'local.db'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe('runReindexCmd — help and flags', () => {
  it('--help prints banner and returns 0', async () => {
    const streams = captureStreams();
    const code = await runReindexCmd(['--help'], {
      stdout: streams.out,
      stderr: streams.err,
    });
    expect(code).toBe(0);
    expect(streams.outText()).toBe(helpText());
  });

  it('unknown flag returns exit 2', async () => {
    const streams = captureStreams();
    const code = await runReindexCmd(['--gadget'], {
      stdout: streams.out,
      stderr: streams.err,
    });
    expect(code).toBe(2);
    expect(streams.errText()).toMatch(/unknown flag/);
  });
});

const describeIfTs = treeSitterAvailable() ? describe : describe.skip;

describeIfTs('runReindexCmd — pipeline (real tree-sitter)', () => {
  it('wipes existing DB and re-populates', async () => {
    const { root, cleanup: rmRoot } = seedRepo({
      'src/a.ts': 'export function alpha(){ return 1 }\n',
    });
    const { dbPath, cleanup: rmDb } = mkTmpDbPath();
    try {
      // Pre-create a DB file with some stale content to prove it's deleted.
      fs.writeFileSync(dbPath, 'not a real sqlite db');
      expect(fs.existsSync(dbPath)).toBe(true);

      const streams = captureStreams();
      const code = await runReindexCmd([root, '--embed', 'mock'], {
        stdout: streams.out,
        stderr: streams.err,
        resolveDbPath: () => dbPath,
        resolveProjectRoot: (x) => x ?? root,
        buildEmbedder: () => new MockEmbedder(),
        openIndexedDb,
      });
      expect(code).toBe(0);
      // Resulting DB exists and has rows.
      expect(fs.existsSync(dbPath)).toBe(true);
      const txt = streams.outText();
      expect(txt).toMatch(/wiped/);
      expect(txt).toMatch(/indexed\s+1/);
    } finally {
      rmDb();
      rmRoot();
    }
  });
});
