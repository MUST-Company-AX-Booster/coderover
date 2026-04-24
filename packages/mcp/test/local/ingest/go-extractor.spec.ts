/**
 * Phase 11 Wave 4 — L20: Go extractor tests.
 *
 * Gated on TS_REAL=1 (same pattern as Wave 2's tree-sitter tests) because
 * `tree-sitter-go` is a native dep. If the grammar isn't installed the
 * suite is skipped rather than failing.
 *
 * Covers:
 *   - top-level function
 *   - method with pointer receiver       (qualified `Repo.Save`)
 *   - method with value receiver         (qualified `Repo.Save`)
 *   - struct / type-alias / interface
 *   - single-line `import "x"`
 *   - grouped `import ( "x"; "y" )`
 *   - aliased `import alias "x"`
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { computeNodeId } from '../../../src/local/deterministic-ids';
import { computeChunkId } from '../../../src/local/ingest/chunk-id';
import type { Chunk } from '../../../src/local/ingest/chunker';
import {
  extractGoImports,
  extractGoSymbols,
} from '../../../src/local/ingest/go-extractor';
import { parseFile } from '../../../src/local/ingest/grammar-loader';

function goAvailable(): boolean {
  if (process.env.TS_REAL !== '1') return false;
  try {
    parseFile('package main\n', 'go');
    return true;
  } catch {
    return false;
  }
}

const describeIfGo = goAvailable() ? describe : describe.skip;

function parseGo(src: string): any {
  return parseFile(src, 'go');
}

function wholeFileChunk(filePath: string, src: string): Chunk[] {
  const totalLines = src === '' ? 1 : src.split('\n').length;
  return [
    {
      chunkId: computeChunkId(filePath, 1, totalLines),
      filePath,
      lineStart: 1,
      lineEnd: totalLines,
      content: src,
      language: 'go' as const,
    },
  ];
}

describeIfGo('extractGoSymbols (real tree-sitter-go)', () => {
  it('extracts a top-level function', () => {
    const filePath = 'cmd/a.go';
    const src = 'package main\n\nfunc Foo() {}\n';
    const tree = parseGo(src);
    const chunks = wholeFileChunk(filePath, src);

    const symbols = extractGoSymbols({ filePath, chunks, tree });
    const fns = symbols.filter((s) => s.kind === 'function');
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('Foo');
    expect(fns[0].qualified).toBe('Foo');
    expect(fns[0].nodeId).toBe(computeNodeId(filePath, 'function', 'Foo'));
  });

  it('extracts a method with pointer receiver as `Repo.Save`', () => {
    const filePath = 'cmd/a.go';
    const src = [
      'package main',
      '',
      'type Repo struct{}',
      '',
      'func (r *Repo) Save() {}',
      '',
    ].join('\n');
    const tree = parseGo(src);
    const chunks = wholeFileChunk(filePath, src);

    const symbols = extractGoSymbols({ filePath, chunks, tree });
    const method = symbols.find((s) => s.kind === 'method');
    expect(method).toBeDefined();
    expect(method!.name).toBe('Save');
    expect(method!.qualified).toBe('Repo.Save');
    expect(method!.nodeId).toBe(computeNodeId(filePath, 'method', 'Repo.Save'));
  });

  it('extracts a method with value receiver as `Repo.Save`', () => {
    const filePath = 'cmd/a.go';
    const src = [
      'package main',
      '',
      'type Repo struct{}',
      '',
      'func (r Repo) Save() {}',
      '',
    ].join('\n');
    const tree = parseGo(src);
    const chunks = wholeFileChunk(filePath, src);

    const symbols = extractGoSymbols({ filePath, chunks, tree });
    const method = symbols.find((s) => s.kind === 'method');
    expect(method).toBeDefined();
    expect(method!.qualified).toBe('Repo.Save');
  });

  it('extracts `type X struct {}` as a struct symbol', () => {
    const filePath = 'cmd/a.go';
    const src = 'package main\n\ntype Repo struct{}\n';
    const tree = parseGo(src);
    const chunks = wholeFileChunk(filePath, src);

    const symbols = extractGoSymbols({ filePath, chunks, tree });
    const s = symbols.find((x) => x.name === 'Repo');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('struct');
  });

  it('extracts `type Y int` as a type alias', () => {
    const filePath = 'cmd/a.go';
    const src = 'package main\n\ntype Status int\n';
    const tree = parseGo(src);
    const chunks = wholeFileChunk(filePath, src);

    const symbols = extractGoSymbols({ filePath, chunks, tree });
    const s = symbols.find((x) => x.name === 'Status');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('type');
  });

  it('extracts `type Handler interface {}` as an interface', () => {
    const filePath = 'cmd/a.go';
    const src = 'package main\n\ntype Handler interface{}\n';
    const tree = parseGo(src);
    const chunks = wholeFileChunk(filePath, src);

    const symbols = extractGoSymbols({ filePath, chunks, tree });
    const s = symbols.find((x) => x.name === 'Handler');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('interface');
  });

  it('nodeId is exactly computeNodeId(filePath, kind, qualified)', () => {
    const filePath = 'cmd/nid.go';
    const src = [
      'package main',
      '',
      'type Repo struct{}',
      '',
      'func (r *Repo) Save() {}',
      'func Standalone() {}',
      '',
    ].join('\n');
    const tree = parseGo(src);
    const chunks = wholeFileChunk(filePath, src);

    const symbols = extractGoSymbols({ filePath, chunks, tree });
    for (const s of symbols) {
      expect(s.nodeId).toBe(computeNodeId(filePath, s.kind, s.qualified));
      expect(s.nodeId).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describeIfGo('extractGoImports (real tree-sitter-go)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-go-extractor-'));
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

  it('single `import "github.com/foo/bar"` -> 1 bare import', () => {
    const abs = touch('cmd/a.go');
    const src = 'package main\nimport "github.com/foo/bar"\n';
    const tree = parseGo(src);

    const out = extractGoImports({
      filePath: 'cmd/a.go',
      absolutePath: abs,
      repoRoot: tmpRoot,
      tree,
    });

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('bare');
    expect(out[0].specifier).toBe('github.com/foo/bar');
    expect(out[0].targetPath).toBe('pkg:github.com/foo/bar');
  });

  it('grouped `import ( "x"; "y" )` -> 2 bare imports', () => {
    const abs = touch('cmd/a.go');
    const src = [
      'package main',
      'import (',
      '    "github.com/x/x"',
      '    "github.com/y/y"',
      ')',
      '',
    ].join('\n');
    const tree = parseGo(src);

    const out = extractGoImports({
      filePath: 'cmd/a.go',
      absolutePath: abs,
      repoRoot: tmpRoot,
      tree,
    });

    expect(out).toHaveLength(2);
    const targets = out.map((o) => o.targetPath).sort();
    expect(targets).toEqual(['pkg:github.com/x/x', 'pkg:github.com/y/y']);
  });

  it('named import `import alias "x"` -> 1 bare import (alias ignored)', () => {
    const abs = touch('cmd/a.go');
    const src = 'package main\nimport alias "github.com/foo/bar"\n';
    const tree = parseGo(src);

    const out = extractGoImports({
      filePath: 'cmd/a.go',
      absolutePath: abs,
      repoRoot: tmpRoot,
      tree,
    });

    expect(out).toHaveLength(1);
    expect(out[0].specifier).toBe('github.com/foo/bar');
    expect(out[0].targetPath).toBe('pkg:github.com/foo/bar');
  });

  it('blank and dot imports reduce to the same bare shape', () => {
    const abs = touch('cmd/a.go');
    const src = [
      'package main',
      'import (',
      '    _ "github.com/blank/pkg"',
      '    . "github.com/dot/pkg"',
      ')',
      '',
    ].join('\n');
    const tree = parseGo(src);

    const out = extractGoImports({
      filePath: 'cmd/a.go',
      absolutePath: abs,
      repoRoot: tmpRoot,
      tree,
    });

    const targets = out.map((o) => o.targetPath).sort();
    expect(targets).toEqual(['pkg:github.com/blank/pkg', 'pkg:github.com/dot/pkg']);
  });

  it('no imports -> empty array', () => {
    const abs = touch('cmd/a.go');
    const tree = parseGo('package main\nfunc main() {}\n');

    const out = extractGoImports({
      filePath: 'cmd/a.go',
      absolutePath: abs,
      repoRoot: tmpRoot,
      tree,
    });

    expect(out).toHaveLength(0);
  });

  it('deduplicates repeat imports of the same path', () => {
    // Two separate import groups both pulling `"x"`. Should dedupe.
    const abs = touch('cmd/a.go');
    const src = [
      'package main',
      'import "github.com/x/x"',
      'import "github.com/x/x"',
      '',
    ].join('\n');
    const tree = parseGo(src);

    const out = extractGoImports({
      filePath: 'cmd/a.go',
      absolutePath: abs,
      repoRoot: tmpRoot,
      tree,
    });

    expect(out).toHaveLength(1);
    expect(out[0].targetPath).toBe('pkg:github.com/x/x');
  });
});
