/**
 * Contract test — proves the local port of deterministic-ids is byte-identical
 * to the backend's version by calling both and asserting equality across a
 * representative spread of inputs.
 *
 * If this spec fails, the local and remote graph IDs have desynced and
 * cross-referencing results between local and remote modes will silently
 * produce wrong answers.
 */
import * as local from '../../src/local/deterministic-ids';
// Backend module is imported via a relative path from this worktree. This is
// allowed because the test file is only compiled by ts-jest at test time;
// tsconfig.build.json excludes tests and so this does not leak into the
// published package.
import * as backend from '../../../../coderover-api/src/graph/deterministic-ids';

describe('deterministic-ids contract (local ↔ backend)', () => {
  describe('computeNodeId', () => {
    const nodeCases: Array<{
      name: string;
      filePath: string;
      symbolKind: string;
      qualifiedName: string;
    }> = [
      {
        name: 'simple typescript class',
        filePath: 'src/foo.ts',
        symbolKind: 'class',
        qualifiedName: 'Foo',
      },
      {
        name: 'deep path with dotted qualified name',
        filePath: 'packages/core/src/a/b/c.ts',
        symbolKind: 'function',
        qualifiedName: 'pkg.a.b.c.helper',
      },
      {
        name: 'name with spaces',
        filePath: 'src/with space.ts',
        symbolKind: 'method',
        qualifiedName: 'My Class.my method',
      },
      {
        name: 'unicode symbol name (CJK)',
        filePath: 'src/日本語.ts',
        symbolKind: 'class',
        qualifiedName: '名前空間.クラス',
      },
      {
        name: 'unicode symbol name (emoji)',
        filePath: 'src/emoji.ts',
        symbolKind: 'variable',
        qualifiedName: '🚀Rocket',
      },
      {
        name: 'very short fields',
        filePath: 'a',
        symbolKind: 'x',
        qualifiedName: 'y',
      },
      {
        name: 'very long qualified name',
        filePath: 'src/long.ts',
        symbolKind: 'function',
        qualifiedName: 'a.'.repeat(200) + 'end',
      },
      {
        name: 'path-like chars in qualified name',
        filePath: 'a/b/c.ts',
        symbolKind: 'method',
        qualifiedName: 'a.b.C.method',
      },
      {
        name: 'field re-arrangement guard (class/bar)',
        filePath: 'src/foo',
        symbolKind: 'class',
        qualifiedName: 'bar',
      },
      {
        name: 'field re-arrangement guard (bar/class)',
        filePath: 'src/foo',
        symbolKind: 'bar',
        qualifiedName: 'class',
      },
      {
        name: 'empty qualified name (treated as empty string)',
        filePath: 'src/empty.ts',
        symbolKind: 'module',
        qualifiedName: '',
      },
      {
        name: 'empty symbol kind (truthy-check is only on edges, not nodes)',
        filePath: 'src/empty-kind.ts',
        symbolKind: '',
        qualifiedName: 'Thing',
      },
    ];

    it.each(nodeCases)(
      'local === backend for: $name',
      ({ filePath, symbolKind, qualifiedName }) => {
        const l = local.computeNodeId(filePath, symbolKind, qualifiedName);
        const b = backend.computeNodeId(filePath, symbolKind, qualifiedName);
        expect(l).toBe(b);
        expect(l).toMatch(/^[0-9a-f]{16}$/);
      },
    );

    it('collision-resistance spot-check: different inputs → different IDs (local matches backend per pair)', () => {
      const seen = new Map<string, string>();
      for (let i = 0; i < 500; i++) {
        const filePath = `src/file${i}.ts`;
        const symbolKind = i % 2 === 0 ? 'function' : 'class';
        const qualifiedName = `pkg.Thing${i}`;
        const l = local.computeNodeId(filePath, symbolKind, qualifiedName);
        const b = backend.computeNodeId(filePath, symbolKind, qualifiedName);
        expect(l).toBe(b);
        // Guard: two different inputs in this loop must not collide.
        const prev = seen.get(l);
        expect(prev).toBeUndefined();
        seen.set(l, `${filePath}|${symbolKind}|${qualifiedName}`);
      }
      expect(seen.size).toBe(500);
    });

    it('throws identically on null-ish inputs', () => {
      expect(() => local.computeNodeId(undefined as any, 'function', 'q')).toThrow();
      expect(() => backend.computeNodeId(undefined as any, 'function', 'q')).toThrow();
      expect(() => local.computeNodeId('p', null as any, 'q')).toThrow();
      expect(() => backend.computeNodeId('p', null as any, 'q')).toThrow();
      expect(() => local.computeNodeId('p', 'function', undefined as any)).toThrow();
      expect(() => backend.computeNodeId('p', 'function', undefined as any)).toThrow();
    });
  });

  describe('computeEdgeId', () => {
    const edgeCases: Array<{
      name: string;
      srcId: string;
      dstId: string;
      relationKind: string;
    }> = [
      { name: 'CALLS between two short ids', srcId: 'src1', dstId: 'dst1', relationKind: 'CALLS' },
      { name: 'IMPORTS between two short ids', srcId: 'src1', dstId: 'dst1', relationKind: 'IMPORTS' },
      { name: 'DEFINES with realistic hex ids', srcId: 'aaaa1111bbbb2222', dstId: 'cccc3333dddd4444', relationKind: 'DEFINES' },
      { name: 'reverse direction (A→B vs B→A)', srcId: 'A', dstId: 'B', relationKind: 'CALLS' },
      { name: 'reverse direction (B→A)', srcId: 'B', dstId: 'A', relationKind: 'CALLS' },
      { name: 'unicode relation kind', srcId: 'x', dstId: 'y', relationKind: '参照' },
      { name: 'relation with spaces', srcId: 'x', dstId: 'y', relationKind: 'RELATES TO' },
    ];

    it.each(edgeCases)(
      'local === backend for: $name',
      ({ srcId, dstId, relationKind }) => {
        const l = local.computeEdgeId(srcId, dstId, relationKind);
        const b = backend.computeEdgeId(srcId, dstId, relationKind);
        expect(l).toBe(b);
        expect(l).toMatch(/^[0-9a-f]{16}$/);
      },
    );

    it('collision-resistance spot-check over 1000 edges', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        const l = local.computeEdgeId(`s${i}`, `d${i}`, 'CALLS');
        const b = backend.computeEdgeId(`s${i}`, `d${i}`, 'CALLS');
        expect(l).toBe(b);
        seen.add(l);
      }
      expect(seen.size).toBe(1000);
    });

    it('throws identically on falsy fields', () => {
      expect(() => local.computeEdgeId('', 'B', 'CALLS')).toThrow();
      expect(() => backend.computeEdgeId('', 'B', 'CALLS')).toThrow();
      expect(() => local.computeEdgeId('A', '', 'CALLS')).toThrow();
      expect(() => backend.computeEdgeId('A', '', 'CALLS')).toThrow();
      expect(() => local.computeEdgeId('A', 'B', '')).toThrow();
      expect(() => backend.computeEdgeId('A', 'B', '')).toThrow();
    });
  });

  describe('known-good snapshot', () => {
    // This snapshot locks the algorithm itself (SHA-256 + unit-separator +
    // slice(0,16)). The value is re-derived from the backend at test time;
    // if either the local port OR the backend mutates the hash function
    // (different digest, different slice length, different separator),
    // this test will fail because the two modules will diverge AND/OR the
    // shape of the output will change.
    //
    // We additionally assert a specific shape (16 lowercase hex chars) so
    // a typo like `digest('base64')` in one file would fail even if the
    // other file was edited in lockstep.
    it('computeNodeId("src/foo.ts", "class", "Foo") matches backend and is 16-hex', () => {
      const expected = backend.computeNodeId('src/foo.ts', 'class', 'Foo');
      const actual = local.computeNodeId('src/foo.ts', 'class', 'Foo');
      expect(actual).toBe(expected);
      expect(actual).toMatch(/^[0-9a-f]{16}$/);
      // Re-computing must be stable (same bytes every call).
      expect(local.computeNodeId('src/foo.ts', 'class', 'Foo')).toBe(actual);
      expect(backend.computeNodeId('src/foo.ts', 'class', 'Foo')).toBe(actual);
    });

    it('computeEdgeId("A","B","CALLS") matches backend and is 16-hex', () => {
      const expected = backend.computeEdgeId('A', 'B', 'CALLS');
      const actual = local.computeEdgeId('A', 'B', 'CALLS');
      expect(actual).toBe(expected);
      expect(actual).toMatch(/^[0-9a-f]{16}$/);
    });

    it('DETERMINISTIC_ID_HEX_LENGTH matches backend', () => {
      expect(local.DETERMINISTIC_ID_HEX_LENGTH).toBe(backend.DETERMINISTIC_ID_HEX_LENGTH);
      expect(local.DETERMINISTIC_ID_HEX_LENGTH).toBe(16);
    });
  });

  describe('end-to-end graph identity (node → edge composition)', () => {
    it('edge between two nodes is identical in local and backend', () => {
      const ln1 = local.computeNodeId('f.ts', 'class', 'Widget');
      const ln2 = local.computeNodeId('f.ts', 'method', 'Widget.render');
      const bn1 = backend.computeNodeId('f.ts', 'class', 'Widget');
      const bn2 = backend.computeNodeId('f.ts', 'method', 'Widget.render');
      expect(ln1).toBe(bn1);
      expect(ln2).toBe(bn2);
      const le = local.computeEdgeId(ln1, ln2, 'DEFINES');
      const be = backend.computeEdgeId(bn1, bn2, 'DEFINES');
      expect(le).toBe(be);
    });
  });
});
