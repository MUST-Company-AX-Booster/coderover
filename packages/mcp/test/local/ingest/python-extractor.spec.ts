/**
 * Phase 11 Wave 4 — L20: Python extractor tests.
 *
 * Gated on TS_REAL=1 (same pattern as Wave 2's tree-sitter tests) because
 * `tree-sitter-python` is a native dep. If the grammar isn't installed the
 * suite is skipped rather than failing.
 *
 * Covers:
 *   - class / class + method / top-level function
 *   - async def (no separate kind)
 *   - decorator-wrapped function
 *   - `import foo` / `import foo.bar`
 *   - `from foo.bar import x`
 *   - `from .sibling import x` (one-level relative)
 *   - `from ..parent.module import x` (two-level relative)
 *   - nodeId == computeNodeId(filePath, kind, qualified)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { computeNodeId } from '../../../src/local/deterministic-ids';
import { computeChunkId } from '../../../src/local/ingest/chunk-id';
import type { Chunk } from '../../../src/local/ingest/chunker';
import { parseFile } from '../../../src/local/ingest/grammar-loader';
import {
  extractPythonImports,
  extractPythonSymbols,
} from '../../../src/local/ingest/python-extractor';

function pythonAvailable(): boolean {
  if (process.env.TS_REAL !== '1') return false;
  try {
    parseFile('pass\n', 'python');
    return true;
  } catch {
    return false;
  }
}

const describeIfPython = pythonAvailable() ? describe : describe.skip;

function parsePy(src: string): any {
  return parseFile(src, 'python');
}

/**
 * Build a single whole-file chunk so the symbol extractor always finds a
 * containing chunk. We deliberately don't use `chunkFile` — the Wave 4
 * chunker doesn't know Python yet; the extractor test should decouple
 * from chunker support.
 */
function wholeFileChunk(filePath: string, src: string): Chunk[] {
  const totalLines = src === '' ? 1 : src.split('\n').length;
  return [
    {
      chunkId: computeChunkId(filePath, 1, totalLines),
      filePath,
      lineStart: 1,
      lineEnd: totalLines,
      content: src,
      // Cast: Chunk.language is SupportedLanguage but our tests don't
      // depend on the exact value beyond round-tripping.
      language: 'python' as const,
    },
  ];
}

describeIfPython('extractPythonSymbols (real tree-sitter-python)', () => {
  it('extracts a class declaration', () => {
    const filePath = 'src/a.py';
    const src = 'class Foo:\n    pass\n';
    const tree = parsePy(src);
    const chunks = wholeFileChunk(filePath, src);

    const symbols = extractPythonSymbols({ filePath, chunks, tree });
    const classes = symbols.filter((s) => s.kind === 'class');
    expect(classes).toHaveLength(1);
    expect(classes[0].name).toBe('Foo');
    expect(classes[0].qualified).toBe('Foo');
    expect(classes[0].nodeId).toBe(computeNodeId(filePath, 'class', 'Foo'));
  });

  it('extracts a class + method with qualified Foo.bar', () => {
    const filePath = 'src/a.py';
    const src = 'class Foo:\n    def bar(self):\n        return 1\n';
    const tree = parsePy(src);
    const chunks = wholeFileChunk(filePath, src);

    const symbols = extractPythonSymbols({ filePath, chunks, tree });
    const cls = symbols.find((s) => s.kind === 'class');
    const method = symbols.find((s) => s.kind === 'method');
    expect(cls).toBeDefined();
    expect(cls!.qualified).toBe('Foo');
    expect(method).toBeDefined();
    expect(method!.name).toBe('bar');
    expect(method!.qualified).toBe('Foo.bar');
    expect(method!.nodeId).toBe(computeNodeId(filePath, 'method', 'Foo.bar'));
  });

  it('extracts a top-level function', () => {
    const filePath = 'src/a.py';
    const src = 'def foo():\n    pass\n';
    const tree = parsePy(src);
    const chunks = wholeFileChunk(filePath, src);

    const symbols = extractPythonSymbols({ filePath, chunks, tree });
    const fns = symbols.filter((s) => s.kind === 'function');
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('foo');
    expect(fns[0].qualified).toBe('foo');
  });

  it('treats `async def foo()` the same as a regular function', () => {
    const filePath = 'src/a.py';
    const src = 'async def foo():\n    pass\n';
    const tree = parsePy(src);
    const chunks = wholeFileChunk(filePath, src);

    const symbols = extractPythonSymbols({ filePath, chunks, tree });
    expect(symbols).toHaveLength(1);
    expect(symbols[0].kind).toBe('function');
    expect(symbols[0].name).toBe('foo');
  });

  it('handles @decorator-wrapped functions', () => {
    const filePath = 'src/a.py';
    // `@decorator` parses as a `decorated_definition` wrapping the inner
    // function_definition. We need to still see `foo` as a function.
    const src = '@decorator\ndef foo():\n    pass\n';
    const tree = parsePy(src);
    const chunks = wholeFileChunk(filePath, src);

    const symbols = extractPythonSymbols({ filePath, chunks, tree });
    const foo = symbols.find((s) => s.name === 'foo');
    expect(foo).toBeDefined();
    expect(foo!.kind).toBe('function');
  });

  it('handles @decorator-wrapped methods inside a class', () => {
    const filePath = 'src/a.py';
    const src = [
      'class Foo:',
      '    @staticmethod',
      '    def bar():',
      '        return 1',
      '',
    ].join('\n');
    const tree = parsePy(src);
    const chunks = wholeFileChunk(filePath, src);

    const symbols = extractPythonSymbols({ filePath, chunks, tree });
    const bar = symbols.find((s) => s.name === 'bar');
    expect(bar).toBeDefined();
    expect(bar!.kind).toBe('method');
    expect(bar!.qualified).toBe('Foo.bar');
  });

  it('nodeId is exactly computeNodeId(filePath, kind, qualified)', () => {
    const filePath = 'src/nid.py';
    const src = [
      'class Widget:',
      '    def render(self):',
      '        pass',
      'def helper():',
      '    pass',
      '',
    ].join('\n');
    const tree = parsePy(src);
    const chunks = wholeFileChunk(filePath, src);

    const symbols = extractPythonSymbols({ filePath, chunks, tree });
    expect(symbols.length).toBeGreaterThanOrEqual(3);
    for (const s of symbols) {
      expect(s.nodeId).toBe(computeNodeId(filePath, s.kind, s.qualified));
      expect(s.nodeId).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describeIfPython('extractPythonImports (real tree-sitter-python)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-py-extractor-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function touch(relative: string, content = ''): string {
    const abs = path.join(tmpRoot, relative);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  it('`import foo` -> 1 bare import', () => {
    const abs = touch('pkg/a.py');
    const tree = parsePy('import foo\n');

    const out = extractPythonImports({
      filePath: 'pkg/a.py',
      absolutePath: abs,
      repoRoot: tmpRoot,
      tree,
    });

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('bare');
    expect(out[0].specifier).toBe('foo');
    expect(out[0].targetPath).toBe('pkg:foo');
  });

  it('`import foo.bar` -> 1 bare import targeting foo.bar', () => {
    const abs = touch('pkg/a.py');
    const tree = parsePy('import foo.bar\n');

    const out = extractPythonImports({
      filePath: 'pkg/a.py',
      absolutePath: abs,
      repoRoot: tmpRoot,
      tree,
    });

    expect(out).toHaveLength(1);
    expect(out[0].specifier).toBe('foo.bar');
    expect(out[0].targetPath).toBe('pkg:foo.bar');
  });

  it('`from foo.bar import x` -> 1 bare import targeting foo.bar', () => {
    const abs = touch('pkg/a.py');
    const tree = parsePy('from foo.bar import x\n');

    const out = extractPythonImports({
      filePath: 'pkg/a.py',
      absolutePath: abs,
      repoRoot: tmpRoot,
      tree,
    });

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('bare');
    expect(out[0].specifier).toBe('foo.bar');
    expect(out[0].targetPath).toBe('pkg:foo.bar');
  });

  it('`from .sibling import x` -> 1 relative import resolving to same dir', () => {
    // Layout: pkg/sub/a.py + pkg/sub/sibling.py — the import should
    // resolve to pkg/sub/sibling.py.
    const abs = touch('pkg/sub/a.py');
    touch('pkg/sub/sibling.py');

    const tree = parsePy('from .sibling import x\n');
    const out = extractPythonImports({
      filePath: 'pkg/sub/a.py',
      absolutePath: abs,
      repoRoot: tmpRoot,
      tree,
    });

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('relative');
    expect(out[0].specifier).toBe('.sibling');
    expect(out[0].targetPath).toBe('pkg/sub/sibling.py');
  });

  it('`from ..parent.module import x` -> 1 relative import resolving up two levels', () => {
    // Layout: pkg/sub/deep/a.py, the import `..parent.module` should
    // resolve relative to pkg/sub (one level up from deep).
    const abs = touch('pkg/sub/deep/a.py');
    touch('pkg/sub/parent/module.py');

    const tree = parsePy('from ..parent.module import x\n');
    const out = extractPythonImports({
      filePath: 'pkg/sub/deep/a.py',
      absolutePath: abs,
      repoRoot: tmpRoot,
      tree,
    });

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('relative');
    expect(out[0].specifier).toBe('..parent.module');
    expect(out[0].targetPath).toBe('pkg/sub/parent/module.py');
  });

  it('unresolved relative still emits edge with extensionless stub', () => {
    // `./missing` doesn't exist — the resolver's best-effort fallback
    // emits the extensionless stub so Wave 3 can still index the edge.
    const abs = touch('pkg/sub/a.py');
    const tree = parsePy('from .missing import x\n');

    const out = extractPythonImports({
      filePath: 'pkg/sub/a.py',
      absolutePath: abs,
      repoRoot: tmpRoot,
      tree,
    });

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('relative');
    expect(out[0].targetPath).toBe('pkg/sub/missing');
  });

  it('handles `from .pkg import x` where `pkg/__init__.py` exists', () => {
    const abs = touch('root/a.py');
    touch('root/pkg/__init__.py');

    const tree = parsePy('from .pkg import x\n');
    const out = extractPythonImports({
      filePath: 'root/a.py',
      absolutePath: abs,
      repoRoot: tmpRoot,
      tree,
    });

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('relative');
    expect(out[0].targetPath).toBe('root/pkg/__init__.py');
  });

  it('deduplicates repeat imports of the same target', () => {
    const abs = touch('pkg/a.py');
    const tree = parsePy([
      'import foo',
      'import foo',
      'from foo import bar',
    ].join('\n'));

    const out = extractPythonImports({
      filePath: 'pkg/a.py',
      absolutePath: abs,
      repoRoot: tmpRoot,
      tree,
    });

    // `import foo` and `from foo import bar` both target pkg:foo.
    expect(out).toHaveLength(1);
    expect(out[0].targetPath).toBe('pkg:foo');
  });
});
