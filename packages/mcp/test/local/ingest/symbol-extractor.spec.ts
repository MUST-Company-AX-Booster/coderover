/**
 * Symbol extractor integration tests. Same shape as chunker.spec.ts —
 * real tree-sitter, skipped at the `describe` level if not installed.
 *
 * Invariants asserted:
 *   - `nodeId === computeNodeId(filePath, kind, qualified)` exactly.
 *   - Same symbol in different files gets different nodeIds.
 *   - Method qualified names are `Class.method`.
 *   - Anonymous-class methods are skipped (documented decision).
 */

import { chunkFile } from '../../../src/local/ingest/chunker';
import { extractSymbols } from '../../../src/local/ingest/symbol-extractor';
import { computeNodeId } from '../../../src/local/deterministic-ids';

import { parseSharedJs, treeSitterAvailable } from '../../helpers/tree-sitter-singleton';
const parseJs = (src: string) => parseSharedJs(src);
const describeIfTreeSitter = treeSitterAvailable() ? describe : describe.skip;

describeIfTreeSitter('extractSymbols (real tree-sitter-javascript)', () => {
  const language = 'javascript' as const;

  it('extracts a class declaration as a class symbol', () => {
    const filePath = 'src/a.js';
    const src = 'class Foo {}\n';
    const tree = parseJs(src)!;
    const chunks = chunkFile({ filePath, content: src, language, tree });
    const symbols = extractSymbols({ filePath, chunks, tree });

    expect(symbols).toHaveLength(1);
    expect(symbols[0].kind).toBe('class');
    expect(symbols[0].name).toBe('Foo');
    expect(symbols[0].qualified).toBe('Foo');
    expect(symbols[0].nodeId).toBe(computeNodeId(filePath, 'class', 'Foo'));
  });

  it('extracts class + method with qualified name Foo.bar', () => {
    const filePath = 'src/a.js';
    const src = 'class Foo {\n  bar() { return 1; }\n}\n';
    const tree = parseJs(src)!;
    const chunks = chunkFile({ filePath, content: src, language, tree });
    const symbols = extractSymbols({ filePath, chunks, tree });

    expect(symbols).toHaveLength(2);
    const classSym = symbols.find((s) => s.kind === 'class')!;
    const methodSym = symbols.find((s) => s.kind === 'method')!;
    expect(classSym.qualified).toBe('Foo');
    expect(methodSym.name).toBe('bar');
    expect(methodSym.qualified).toBe('Foo.bar');
    expect(methodSym.nodeId).toBe(computeNodeId(filePath, 'method', 'Foo.bar'));
  });

  it('emits constructor with kind "constructor"', () => {
    const filePath = 'src/c.js';
    const src = 'class Foo {\n  constructor() { this.x = 0; }\n}\n';
    const tree = parseJs(src)!;
    const chunks = chunkFile({ filePath, content: src, language, tree });
    const symbols = extractSymbols({ filePath, chunks, tree });

    const ctor = symbols.find((s) => s.kind === 'constructor');
    expect(ctor).toBeDefined();
    expect(ctor!.name).toBe('constructor');
    expect(ctor!.qualified).toBe('Foo.constructor');
    expect(ctor!.nodeId).toBe(computeNodeId(filePath, 'constructor', 'Foo.constructor'));
  });

  it('extracts both function declarations and arrow-assigned functions', () => {
    const filePath = 'src/f.js';
    const src = 'function a() { return 1; }\nconst b = () => 2;\n';
    const tree = parseJs(src)!;
    const chunks = chunkFile({ filePath, content: src, language, tree });
    const symbols = extractSymbols({ filePath, chunks, tree });

    const a = symbols.find((s) => s.name === 'a');
    const b = symbols.find((s) => s.name === 'b');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.kind).toBe('function');
    expect(b!.kind).toBe('function');
    expect(a!.qualified).toBe('a');
    expect(b!.qualified).toBe('b');
  });

  it('gracefully handles `interface I {}` under the JS grammar', () => {
    // Documented behavior: the JavaScript grammar doesn't know `interface`,
    // so it parses as something other than `interface_declaration`. The
    // symbol extractor must NOT crash and MAY produce zero `interface`
    // symbols — which is what we assert here.
    const filePath = 'src/i.js';
    const src = 'interface I {}\n';
    const tree = parseJs(src)!;
    expect(tree.rootNode).toBeDefined();

    const chunks = chunkFile({ filePath, content: src, language, tree });
    expect(() => extractSymbols({ filePath, chunks, tree })).not.toThrow();

    const symbols = extractSymbols({ filePath, chunks, tree });
    // Either zero symbols OR one with kind 'interface' — never a crash.
    for (const s of symbols) {
      expect(typeof s.name).toBe('string');
    }
  });

  it('skips methods inside an ANONYMOUS class expression (documented)', () => {
    // `const C = class { m() {} }` — the class has no `name` field.
    // Our chunker does not emit the class or its methods (the outer
    // `lexical_declaration` covers the span), and the extractor
    // mirrors that decision.
    const filePath = 'src/anon.js';
    const src = 'const C = class { m() { return 1; } };\n';
    const tree = parseJs(src)!;
    const chunks = chunkFile({ filePath, content: src, language, tree });
    const symbols = extractSymbols({ filePath, chunks, tree });

    const names = symbols.map((s) => s.name);
    expect(names).not.toContain('m');
    // Must not crash, must not produce `<anonymous>.m`.
    for (const s of symbols) {
      expect(s.qualified.includes('<anonymous>')).toBe(false);
    }
  });

  it('nodeId is exactly computeNodeId(filePath, kind, qualified)', () => {
    const filePath = 'src/nid.js';
    const src = [
      'class Widget {',
      '  render() {}',
      '}',
      'function helper() {}',
      'const arrow = () => 0;',
      '',
    ].join('\n');
    const tree = parseJs(src)!;
    const chunks = chunkFile({ filePath, content: src, language, tree });
    const symbols = extractSymbols({ filePath, chunks, tree });

    for (const s of symbols) {
      expect(s.nodeId).toBe(computeNodeId(filePath, s.kind, s.qualified));
      expect(s.nodeId).toMatch(/^[0-9a-f]{16}$/);
    }
    const qualifieds = symbols.map((s) => s.qualified).sort();
    expect(qualifieds).toEqual(['Widget', 'Widget.render', 'arrow', 'helper']);
  });

  it('same kind+name in different files produces different nodeIds', () => {
    const srcA = 'function foo() {}\n';
    const srcB = 'function foo() {}\n';
    const treeA = parseJs(srcA)!;
    const treeB = parseJs(srcB)!;

    const chunksA = chunkFile({ filePath: 'src/a.js', content: srcA, language, tree: treeA });
    const chunksB = chunkFile({ filePath: 'src/b.js', content: srcB, language, tree: treeB });

    const symsA = extractSymbols({ filePath: 'src/a.js', chunks: chunksA, tree: treeA });
    const symsB = extractSymbols({ filePath: 'src/b.js', chunks: chunksB, tree: treeB });

    expect(symsA).toHaveLength(1);
    expect(symsB).toHaveLength(1);
    expect(symsA[0].nodeId).not.toBe(symsB[0].nodeId);
    expect(symsA[0].qualified).toBe(symsB[0].qualified);
  });

  it('every symbol binds to a chunk that exists in the input', () => {
    const filePath = 'src/multi.js';
    const src = [
      'class A {',
      '  a() {}',
      '  b() {}',
      '}',
      'function top() {}',
      '',
    ].join('\n');
    const tree = parseJs(src)!;
    const chunks = chunkFile({ filePath, content: src, language, tree });
    const symbols = extractSymbols({ filePath, chunks, tree });

    const chunkIds = new Set(chunks.map((c) => c.chunkId));
    for (const s of symbols) {
      expect(chunkIds.has(s.chunkId)).toBe(true);
    }
  });
});
