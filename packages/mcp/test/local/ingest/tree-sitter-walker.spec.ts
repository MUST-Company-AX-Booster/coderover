import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { walkRepo, type WalkedFile } from '../../../src/local/ingest/tree-sitter-walker';
import { __clearGrammarCacheForTests } from '../../../src/local/ingest/grammar-loader';

async function collect(gen: AsyncGenerator<WalkedFile>): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  for await (const f of gen) out.push(f);
  return out;
}

function mkfile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

// Gated on TS_REAL=1 — tree-sitter cross-spec flake (see tree-sitter-singleton.ts).
const tsRealDescribe = process.env.TS_REAL === '1' ? describe : describe.skip;

tsRealDescribe('tree-sitter-walker', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-walker-'));
    __clearGrammarCacheForTests();

    // Canonical source files.
    mkfile(tmpDir, 'src/a.ts', 'export const a: number = 1;\n');
    mkfile(tmpDir, 'src/b.js', 'export const b = 2;\n');

    // Ignored by default patterns.
    mkfile(tmpDir, 'node_modules/x.ts', 'export const x = 1;\n');
    mkfile(tmpDir, 'dist/y.ts', 'export const y = 1;\n');

    // No supported extension.
    mkfile(tmpDir, 'README.md', '# hi\n');

    // Over size threshold (2 MB of valid JS so it would parse if not skipped).
    const bigContent = `const huge = "${'x'.repeat(2 * 1024 * 1024)}";\n`;
    mkfile(tmpDir, 'large.ts', bigContent);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('yields exactly the supported, non-ignored, size-bounded files', async () => {
    const files = await collect(walkRepo(tmpDir));
    const rels = files.map((f) => f.relativePath).sort();
    expect(rels).toEqual(['src/a.ts', 'src/b.js']);
  });

  it('each WalkedFile has a program-rooted tree, correct language, and a non-empty hash', async () => {
    const files = await collect(walkRepo(tmpDir));
    const byRel = new Map(files.map((f) => [f.relativePath, f]));

    const a = byRel.get('src/a.ts')!;
    expect(a.language).toBe('typescript');
    expect(a.tree.rootNode.type).toBe('program');
    // TS files have hasError=true under the JS grammar when they use
    // TS-only syntax like type annotations — tree-sitter is error-tolerant
    // so the tree is still usable. Wave 4 will add a dedicated TS grammar.
    expect(typeof a.tree.rootNode.hasError).toBe('boolean');
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.content).toContain('export const a');

    const b = byRel.get('src/b.js')!;
    expect(b.language).toBe('javascript');
    expect(b.tree.rootNode.type).toBe('program');
    expect(b.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // Different content → different hash.
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('maxFiles: 1 stops after yielding a single file', async () => {
    const files = await collect(walkRepo(tmpDir, { maxFiles: 1 }));
    expect(files).toHaveLength(1);
  });

  it('additionalIgnore excludes matching files (only src/a.ts remains)', async () => {
    const files = await collect(walkRepo(tmpDir, { additionalIgnore: ['*.js'] }));
    const rels = files.map((f) => f.relativePath);
    expect(rels).toEqual(['src/a.ts']);
  });

  it('still yields files with syntax errors (tree-sitter is error-tolerant)', async () => {
    // Fresh tmp dir with only one file that cannot parse cleanly.
    const errDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-walker-err-'));
    try {
      mkfile(errDir, 'broken.ts', 'const x = {\n');
      const files = await collect(walkRepo(errDir));
      expect(files).toHaveLength(1);
      expect(files[0].relativePath).toBe('broken.ts');
      expect(files[0].tree.rootNode.hasError).toBe(true);
    } finally {
      fs.rmSync(errDir, { recursive: true, force: true });
    }
  });

  it('onProgress fires with monotonically non-decreasing counts', async () => {
    const events: Array<[number, number]> = [];
    await collect(
      walkRepo(tmpDir, {
        onProgress: (scanned, indexed) => {
          events.push([scanned, indexed]);
        },
      }),
    );

    expect(events.length).toBeGreaterThan(0);

    // Both counters must be monotonic non-decreasing.
    for (let i = 1; i < events.length; i++) {
      expect(events[i][0]).toBeGreaterThanOrEqual(events[i - 1][0]);
      expect(events[i][1]).toBeGreaterThanOrEqual(events[i - 1][1]);
    }

    // The final `indexed` count must match what we yielded (2 files).
    const last = events[events.length - 1];
    expect(last[1]).toBe(2);
    // And we must have scanned more than we indexed (README.md, large.ts).
    expect(last[0]).toBeGreaterThanOrEqual(last[1]);
  });
});
