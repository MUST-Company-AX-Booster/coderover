import {
  computeNodeId,
  computeEdgeId,
  DETERMINISTIC_ID_HEX_LENGTH,
} from './deterministic-ids';

/**
 * Phase 10 C2 — deterministic ID tests.
 *
 * Critical-gap test #3: stability across runs.
 *   - Same (filePath, symbolKind, qualifiedName) must produce the same
 *     nodeId on every invocation, every process, every machine.
 *
 * Also covers:
 *   - same-input-same-output (determinism).
 *   - different inputs → different IDs (collision sanity).
 *   - field ordering matters (separator isolation).
 *   - IDs are 16 hex characters (8 bytes).
 *   - edge IDs depend on relation kind (CALLS ≠ IMPORTS between the
 *     same pair of nodes).
 */
describe('deterministic-ids', () => {
  describe('computeNodeId', () => {
    it('produces a 16-hex-char lowercase string', () => {
      const id = computeNodeId('src/foo.ts', 'function', 'pkg.foo.bar');
      expect(id).toMatch(/^[0-9a-f]{16}$/);
      expect(id).toHaveLength(DETERMINISTIC_ID_HEX_LENGTH);
    });

    it('is deterministic: same input → same output (critical-gap #3)', () => {
      const a = computeNodeId('src/foo.ts', 'function', 'pkg.foo.bar');
      const b = computeNodeId('src/foo.ts', 'function', 'pkg.foo.bar');
      expect(a).toBe(b);
    });

    it('is stable across many invocations (stability across runs)', () => {
      // Simulate "two ingest runs" by computing the ID 1000 times and
      // asserting they all match. If the hash ever becomes non-deterministic
      // (e.g. via env-based salt) this would flake.
      const ids = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        ids.add(computeNodeId('src/a/b.ts', 'class', 'a.b.Widget'));
      }
      expect(ids.size).toBe(1);
    });

    it('distinguishes different filePaths', () => {
      const a = computeNodeId('src/a.ts', 'function', 'f');
      const b = computeNodeId('src/b.ts', 'function', 'f');
      expect(a).not.toBe(b);
    });

    it('distinguishes different symbolKinds', () => {
      const a = computeNodeId('src/a.ts', 'function', 'f');
      const b = computeNodeId('src/a.ts', 'method', 'f');
      expect(a).not.toBe(b);
    });

    it('distinguishes different qualifiedNames', () => {
      const a = computeNodeId('src/a.ts', 'function', 'pkg.a');
      const b = computeNodeId('src/a.ts', 'function', 'pkg.b');
      expect(a).not.toBe(b);
    });

    it('is not confusable by field re-arrangement', () => {
      // Using a separator that cannot appear in a filePath / symbolKind /
      // qualifiedName means "a|b|c" and "ab||c" cannot collide.
      const a = computeNodeId('src/foo', 'class', 'bar');
      const b = computeNodeId('src/foo', 'bar', 'class');
      expect(a).not.toBe(b);
    });

    it('handles names that contain path-like dots and slashes', () => {
      const a = computeNodeId('a/b/c.ts', 'method', 'a.b.C.method');
      const b = computeNodeId('a/b/c.ts', 'method', 'a.b.C.method');
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{16}$/);
    });

    it('throws on null-ish inputs (defensive)', () => {
      expect(() => computeNodeId(undefined as any, 'function', 'q')).toThrow();
      expect(() => computeNodeId('p', null as any, 'q')).toThrow();
      expect(() => computeNodeId('p', 'function', undefined as any)).toThrow();
    });
  });

  describe('computeEdgeId', () => {
    it('produces a 16-hex-char lowercase string', () => {
      const id = computeEdgeId('src1', 'dst1', 'CALLS');
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    });

    it('is deterministic', () => {
      const a = computeEdgeId('src1', 'dst1', 'CALLS');
      const b = computeEdgeId('src1', 'dst1', 'CALLS');
      expect(a).toBe(b);
    });

    it('distinguishes different relation kinds between the same pair', () => {
      const calls = computeEdgeId('src1', 'dst1', 'CALLS');
      const imports = computeEdgeId('src1', 'dst1', 'IMPORTS');
      expect(calls).not.toBe(imports);
    });

    it('is direction-sensitive (src → dst ≠ dst → src)', () => {
      const fwd = computeEdgeId('A', 'B', 'CALLS');
      const rev = computeEdgeId('B', 'A', 'CALLS');
      expect(fwd).not.toBe(rev);
    });

    it('throws on missing fields', () => {
      expect(() => computeEdgeId('', 'B', 'CALLS')).toThrow();
      expect(() => computeEdgeId('A', '', 'CALLS')).toThrow();
      expect(() => computeEdgeId('A', 'B', '')).toThrow();
    });

    it('collision sanity across many unique inputs', () => {
      // Generate 10k distinct edge tuples; the 64-bit truncated hash
      // should produce 10k distinct IDs with overwhelming probability.
      const ids = new Set<string>();
      for (let i = 0; i < 10000; i++) {
        ids.add(computeEdgeId(`s${i}`, `d${i}`, 'CALLS'));
      }
      expect(ids.size).toBe(10000);
    });
  });

  it('node and edge hashes agree across runs for the same logical entity', () => {
    const n1 = computeNodeId('f.ts', 'class', 'Widget');
    const n2 = computeNodeId('f.ts', 'method', 'Widget.render');
    const e1 = computeEdgeId(n1, n2, 'DEFINES');
    const e2 = computeEdgeId(n1, n2, 'DEFINES');
    expect(e1).toBe(e2);
  });
});
