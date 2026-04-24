/**
 * Phase 11 Wave 4 — L20: Java extractor tests.
 *
 * Gated on TS_REAL=1 (same pattern as Wave 2's tree-sitter tests) because
 * `tree-sitter-java` is a native dep. If the grammar isn't installed the
 * suite is skipped rather than failing.
 *
 * Covers:
 *   - class / interface / enum
 *   - class + method
 *   - class + constructor
 *   - `import java.util.List;`
 *   - `import static java.util.Arrays.asList;`
 *   - `package com.example;` is NOT an import (regression guard)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { computeNodeId } from '../../../src/local/deterministic-ids';
import { computeChunkId } from '../../../src/local/ingest/chunk-id';
import type { Chunk } from '../../../src/local/ingest/chunker';
import { parseFile } from '../../../src/local/ingest/grammar-loader';
import {
  extractJavaImports,
  extractJavaSymbols,
} from '../../../src/local/ingest/java-extractor';

function javaAvailable(): boolean {
  if (process.env.TS_REAL !== '1') return false;
  try {
    parseFile('class X {}\n', 'java');
    return true;
  } catch {
    return false;
  }
}

const describeIfJava = javaAvailable() ? describe : describe.skip;

function parseJava(src: string): any {
  return parseFile(src, 'java');
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
      language: 'java' as const,
    },
  ];
}

describeIfJava('extractJavaSymbols (real tree-sitter-java)', () => {
  it('extracts `class Foo {}`', () => {
    const filePath = 'Foo.java';
    const src = 'class Foo {}\n';
    const tree = parseJava(src);
    const chunks = wholeFileChunk(filePath, src);

    const symbols = extractJavaSymbols({ filePath, chunks, tree });
    expect(symbols).toHaveLength(1);
    expect(symbols[0].kind).toBe('class');
    expect(symbols[0].name).toBe('Foo');
    expect(symbols[0].qualified).toBe('Foo');
    expect(symbols[0].nodeId).toBe(computeNodeId(filePath, 'class', 'Foo'));
  });

  it('extracts `interface I {}`', () => {
    const filePath = 'I.java';
    const src = 'interface I {}\n';
    const tree = parseJava(src);
    const chunks = wholeFileChunk(filePath, src);

    const symbols = extractJavaSymbols({ filePath, chunks, tree });
    expect(symbols).toHaveLength(1);
    expect(symbols[0].kind).toBe('interface');
    expect(symbols[0].name).toBe('I');
  });

  it('extracts `enum E { A, B }`', () => {
    const filePath = 'E.java';
    const src = 'enum E { A, B }\n';
    const tree = parseJava(src);
    const chunks = wholeFileChunk(filePath, src);

    const symbols = extractJavaSymbols({ filePath, chunks, tree });
    const enumSym = symbols.find((s) => s.kind === 'enum');
    expect(enumSym).toBeDefined();
    expect(enumSym!.name).toBe('E');
    expect(enumSym!.qualified).toBe('E');
  });

  it('extracts class + method with qualified `Foo.bar`', () => {
    const filePath = 'Foo.java';
    const src = 'class Foo { void bar() {} }\n';
    const tree = parseJava(src);
    const chunks = wholeFileChunk(filePath, src);

    const symbols = extractJavaSymbols({ filePath, chunks, tree });
    const cls = symbols.find((s) => s.kind === 'class');
    const method = symbols.find((s) => s.kind === 'method');
    expect(cls).toBeDefined();
    expect(cls!.name).toBe('Foo');
    expect(method).toBeDefined();
    expect(method!.name).toBe('bar');
    expect(method!.qualified).toBe('Foo.bar');
    expect(method!.nodeId).toBe(computeNodeId(filePath, 'method', 'Foo.bar'));
  });

  it('extracts class + constructor with qualified `Foo.Foo`', () => {
    const filePath = 'Foo.java';
    const src = 'class Foo { Foo() {} }\n';
    const tree = parseJava(src);
    const chunks = wholeFileChunk(filePath, src);

    const symbols = extractJavaSymbols({ filePath, chunks, tree });
    const ctor = symbols.find((s) => s.kind === 'constructor');
    expect(ctor).toBeDefined();
    expect(ctor!.qualified).toBe('Foo.Foo');
    expect(ctor!.nodeId).toBe(computeNodeId(filePath, 'constructor', 'Foo.Foo'));
  });

  it('nodeId is exactly computeNodeId(filePath, kind, qualified) across symbols', () => {
    const filePath = 'Widget.java';
    const src = [
      'class Widget {',
      '  Widget() {}',
      '  void render() {}',
      '}',
      '',
    ].join('\n');
    const tree = parseJava(src);
    const chunks = wholeFileChunk(filePath, src);

    const symbols = extractJavaSymbols({ filePath, chunks, tree });
    expect(symbols.length).toBeGreaterThanOrEqual(3);
    for (const s of symbols) {
      expect(s.nodeId).toBe(computeNodeId(filePath, s.kind, s.qualified));
      expect(s.nodeId).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describeIfJava('extractJavaImports (real tree-sitter-java)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-java-extractor-'));
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

  it('`import java.util.List;` -> 1 bare import', () => {
    const abs = touch('Foo.java');
    const src = 'import java.util.List;\nclass Foo {}\n';
    const tree = parseJava(src);

    const out = extractJavaImports({
      filePath: 'Foo.java',
      absolutePath: abs,
      repoRoot: tmpRoot,
      tree,
    });

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('bare');
    expect(out[0].specifier).toBe('java.util.List');
    expect(out[0].targetPath).toBe('pkg:java.util.List');
  });

  it('`import static java.util.Arrays.asList;` -> 1 bare import (static ignored)', () => {
    const abs = touch('Foo.java');
    const src = 'import static java.util.Arrays.asList;\nclass Foo {}\n';
    const tree = parseJava(src);

    const out = extractJavaImports({
      filePath: 'Foo.java',
      absolutePath: abs,
      repoRoot: tmpRoot,
      tree,
    });

    expect(out).toHaveLength(1);
    expect(out[0].specifier).toBe('java.util.Arrays.asList');
    expect(out[0].targetPath).toBe('pkg:java.util.Arrays.asList');
  });

  it('`package com.example;` is NOT an import (regression guard)', () => {
    const abs = touch('Foo.java');
    const src = 'package com.example;\nclass Foo {}\n';
    const tree = parseJava(src);

    const out = extractJavaImports({
      filePath: 'Foo.java',
      absolutePath: abs,
      repoRoot: tmpRoot,
      tree,
    });

    expect(out).toHaveLength(0);
  });

  it('star import `import java.util.*;` -> 1 bare import with .* specifier', () => {
    const abs = touch('Foo.java');
    const src = 'import java.util.*;\nclass Foo {}\n';
    const tree = parseJava(src);

    const out = extractJavaImports({
      filePath: 'Foo.java',
      absolutePath: abs,
      repoRoot: tmpRoot,
      tree,
    });

    expect(out).toHaveLength(1);
    expect(out[0].specifier).toBe('java.util.*');
    expect(out[0].targetPath).toBe('pkg:java.util.*');
  });

  it('multiple distinct imports -> one edge each', () => {
    const abs = touch('Foo.java');
    const src = [
      'package com.example;',
      'import java.util.List;',
      'import java.util.Map;',
      'class Foo {}',
      '',
    ].join('\n');
    const tree = parseJava(src);

    const out = extractJavaImports({
      filePath: 'Foo.java',
      absolutePath: abs,
      repoRoot: tmpRoot,
      tree,
    });

    expect(out).toHaveLength(2);
    const targets = out.map((o) => o.targetPath).sort();
    expect(targets).toEqual(['pkg:java.util.List', 'pkg:java.util.Map']);
  });

  it('deduplicates repeat imports of the same path', () => {
    const abs = touch('Foo.java');
    const src = [
      'import java.util.List;',
      'import java.util.List;',
      'class Foo {}',
      '',
    ].join('\n');
    const tree = parseJava(src);

    const out = extractJavaImports({
      filePath: 'Foo.java',
      absolutePath: abs,
      repoRoot: tmpRoot,
      tree,
    });

    expect(out).toHaveLength(1);
    expect(out[0].targetPath).toBe('pkg:java.util.List');
  });
});
