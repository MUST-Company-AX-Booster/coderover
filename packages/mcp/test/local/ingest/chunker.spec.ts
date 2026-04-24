/**
 * AST chunker integration tests. Uses real tree-sitter parsing so we're
 * testing against the same grammar the ingestion pipeline uses at
 * runtime — no structural mocks. If tree-sitter isn't installed yet, the
 * whole suite is skipped at the `describe` level rather than silently
 * passing: jest will explicitly report "skipped".
 */

import { chunkFile } from '../../../src/local/ingest/chunker';

import { parseSharedJs, treeSitterAvailable } from '../../helpers/tree-sitter-singleton';
const parseJs = (src: string) => parseSharedJs(src);
const describeIfTreeSitter = treeSitterAvailable() ? describe : describe.skip;

describeIfTreeSitter('chunkFile (real tree-sitter-javascript)', () => {
  const language = 'javascript' as const;
  const filePath = 'src/test.js';

  it('emits one chunk for a single function declaration', () => {
    const src = 'function foo() { return 1; }\n';
    const tree = parseJs(src)!;
    const chunks = chunkFile({ filePath, content: src, language, tree });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].symbolKind).toBe('function');
    expect(chunks[0].symbolName).toBe('foo');
    expect(chunks[0].lineStart).toBe(1);
    expect(chunks[0].lineEnd).toBe(1);
    expect(chunks[0].chunkId).toMatch(/^[0-9a-f]{16}$/);
    expect(chunks[0].language).toBe('javascript');
    expect(chunks[0].filePath).toBe(filePath);
  });

  it('emits class + one chunk per method for a class with two methods', () => {
    const src = [
      'class A {',
      '  a() { return 1; }',
      '  b() { return 2; }',
      '}',
      '',
    ].join('\n');
    const tree = parseJs(src)!;
    const chunks = chunkFile({ filePath, content: src, language, tree });

    expect(chunks).toHaveLength(3);

    const classChunk = chunks.find((c) => c.symbolKind === 'class');
    expect(classChunk).toBeDefined();
    expect(classChunk!.symbolName).toBe('A');
    expect(classChunk!.lineStart).toBe(1);
    expect(classChunk!.lineEnd).toBe(4);

    const methodChunks = chunks.filter((c) => c.symbolKind === 'method');
    expect(methodChunks).toHaveLength(2);
    const names = methodChunks.map((c) => c.symbolName).sort();
    expect(names).toEqual(['A.a', 'A.b']);

    // Line spans are correct and method chunks live inside the class chunk.
    for (const m of methodChunks) {
      expect(m.lineStart).toBeGreaterThanOrEqual(classChunk!.lineStart);
      expect(m.lineEnd).toBeLessThanOrEqual(classChunk!.lineEnd);
    }
  });

  it('emits one chunk for a top-level `const f = () => 1`', () => {
    const src = 'const f = () => 1;\n';
    const tree = parseJs(src)!;
    const chunks = chunkFile({ filePath, content: src, language, tree });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].symbolKind).toBe('function');
    expect(chunks[0].symbolName).toBe('f');
  });

  it('emits one chunk for `const f = function named() {}` using the variable name', () => {
    // Documented behavior: the variable name ('f') takes precedence over the
    // function expression's inner name ('named'). Rationale: the binding that
    // other code imports is `f`, so that's the searchable handle.
    const src = 'const f = function named() { return 1; };\n';
    const tree = parseJs(src)!;
    const chunks = chunkFile({ filePath, content: src, language, tree });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].symbolName).toBe('f');
    expect(chunks[0].symbolKind).toBe('function');
  });

  it('emits a whole-file chunk with no symbol fields for an empty file', () => {
    const src = '';
    const tree = parseJs(src)!;
    const chunks = chunkFile({ filePath, content: src, language, tree });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].symbolKind).toBeUndefined();
    expect(chunks[0].symbolName).toBeUndefined();
    expect(chunks[0].content).toBe('');
    expect(chunks[0].lineStart).toBe(1);
    expect(chunks[0].lineEnd).toBe(1);
  });

  it('emits a whole-file chunk for a file with only imports (no funcs/classes)', () => {
    const src = [
      "import { foo } from './foo';",
      "import { bar } from './bar';",
      '',
    ].join('\n');
    const tree = parseJs(src)!;
    const chunks = chunkFile({ filePath, content: src, language, tree });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].symbolKind).toBeUndefined();
    expect(chunks[0].symbolName).toBeUndefined();
    expect(chunks[0].content).toContain('import');
  });

  it('does not emit nested functions — only the outer one', () => {
    // Wave 2 scope: nested functions are a follow-up. We intentionally
    // don't descend into function bodies.
    const src = [
      'function outer() {',
      '  function inner() { return 1; }',
      '  return inner();',
      '}',
      '',
    ].join('\n');
    const tree = parseJs(src)!;
    const chunks = chunkFile({ filePath, content: src, language, tree });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].symbolName).toBe('outer');
  });

  it('returns at least one chunk for a syntactically broken file', () => {
    const src = 'function broken(\n  return;\n';
    const tree = parseJs(src)!;
    // Sanity: tree-sitter still parses something (possibly with hasError).
    expect(tree.rootNode).toBeDefined();

    const chunks = chunkFile({ filePath, content: src, language, tree });
    // Either we extract the (broken) function OR we fall back to whole-file.
    // Either way there is at least one chunk and every chunk has a valid
    // line range + chunkId shape.
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const c of chunks) {
      expect(c.lineStart).toBeGreaterThanOrEqual(1);
      expect(c.lineEnd).toBeGreaterThanOrEqual(c.lineStart);
      expect(c.chunkId).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('line numbers are 1-indexed and inclusive', () => {
    const src = [
      '// comment',
      'function foo() {',
      '  return 1;',
      '}',
      '',
    ].join('\n');
    const tree = parseJs(src)!;
    const chunks = chunkFile({ filePath, content: src, language, tree });

    const fooChunk = chunks.find((c) => c.symbolName === 'foo')!;
    expect(fooChunk).toBeDefined();
    // `function foo() {` is line 2, `}` is line 4.
    expect(fooChunk.lineStart).toBe(2);
    expect(fooChunk.lineEnd).toBe(4);
    const lines = fooChunk.content.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('function foo()');
    expect(lines[2]).toContain('}');
  });

  it('chunk IDs are unique within a file', () => {
    const src = [
      'class A {',
      '  a() { return 1; }',
      '  b() { return 2; }',
      '  c() { return 3; }',
      '}',
      '',
      'function top() { return 0; }',
      '',
      'const arrow = () => 42;',
      '',
    ].join('\n');
    const tree = parseJs(src)!;
    const chunks = chunkFile({ filePath, content: src, language, tree });

    const ids = chunks.map((c) => c.chunkId);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    expect(chunks.length).toBeGreaterThanOrEqual(5);
  });

  it('chunk IDs stay unique when class + method share a single-line span', () => {
    // Regression: a single-line class like `class A { m() {} }` used to emit
    // a class chunk AND a method chunk with identical (filePath, lineStart,
    // lineEnd) tuples. That tuple was the entire chunk-ID key, so both rows
    // hashed to the same primary key and the vec0 UNIQUE constraint fired
    // on the second insert (vec0 does not honor INSERT OR REPLACE).
    const src = 'class A { m() { return 1; } }\n';
    const tree = parseJs(src)!;
    const chunks = chunkFile({ filePath, content: src, language, tree });

    const classChunk = chunks.find((c) => c.symbolKind === 'class');
    const methodChunk = chunks.find((c) => c.symbolKind === 'method');
    expect(classChunk).toBeDefined();
    expect(methodChunk).toBeDefined();
    expect(classChunk!.lineStart).toBe(methodChunk!.lineStart);
    expect(classChunk!.lineEnd).toBe(methodChunk!.lineEnd);
    expect(classChunk!.chunkId).not.toBe(methodChunk!.chunkId);
  });

  it('handles generator functions and constructors', () => {
    const src = [
      'function* gen() { yield 1; }',
      '',
      'class C {',
      '  constructor() { this.x = 0; }',
      '  m() { return this.x; }',
      '}',
      '',
    ].join('\n');
    const tree = parseJs(src)!;
    const chunks = chunkFile({ filePath, content: src, language, tree });

    const gen = chunks.find((c) => c.symbolName === 'gen');
    expect(gen).toBeDefined();
    expect(gen!.symbolKind).toBe('function');

    const ctor = chunks.find((c) => c.symbolName === 'C.constructor');
    expect(ctor).toBeDefined();
    expect(ctor!.symbolKind).toBe('constructor');

    const m = chunks.find((c) => c.symbolName === 'C.m');
    expect(m).toBeDefined();
    expect(m!.symbolKind).toBe('method');
  });
});
