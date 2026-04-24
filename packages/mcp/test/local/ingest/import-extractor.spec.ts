/**
 * Tests for Phase 11 Wave 2 L8 — `import-extractor.ts`.
 *
 * Structure: two layers.
 *
 *   1. REAL-AST suite — runs against `tree-sitter` + `tree-sitter-javascript`
 *      when they resolve at test time. This is the gold-standard suite; it
 *      exercises every import form we promise to recognise. The suite is
 *      skipped (via `describeIfGrammar`) when the deps aren't installed
 *      yet — another agent is landing them in a separate task.
 *
 *   2. FAKE-AST suite — runs unconditionally. We hand-build minimal node
 *      structures matching the shape the real grammar produces. This locks
 *      down the tree-walking, de-duplication, and `edgeId` contract even in
 *      environments where tree-sitter native bindings can't be loaded.
 *
 * Both suites cover:
 *   - `import './y'`, `import {a,b} from './y'`, `import x from 'lodash'`,
 *     `import * as ns from './y'`
 *   - `export {x} from './y'`, `export * from './y'`
 *   - `const x = require('./y')`
 *   - `await import('./y')`
 *   - 3-imports-to-same-target -> 1 deduped edge
 *   - no-imports -> 0 results
 *   - deterministic `edgeId` across repeated calls
 *   - different srcFile => different edgeId
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { extractImports } from '../../../src/local/ingest/import-extractor';
import { computeEdgeId, computeNodeId } from '../../../src/local/deterministic-ids';

// ─── Grammar detection ──────────────────────────────────────────────────────

/**
 * Resolve tree-sitter + tree-sitter-javascript at runtime so the suite
 * gracefully skips when the grammar isn't installed yet. We can't use a
 * static import because tsc would error on an unresolvable module — the
 * `tree-sitter` dep is added by a separate agent per the L8 scope note.
 */
import { parseSharedJs, treeSitterAvailable } from '../../helpers/tree-sitter-singleton';
const describeIfGrammar = treeSitterAvailable() ? describe : describe.skip;

// ─── Shared tmp-repo helpers ────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-imp-extractor-'));
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

function parseJS(source: string): { rootNode: any } {
  return parseSharedJs(source);
}

// ─── REAL-AST suite ─────────────────────────────────────────────────────────

describeIfGrammar('extractImports (real tree-sitter)', () => {
  it('side-effect import: import "./y" -> 1 import, relative', () => {
    const srcAbs = touch('src/a.js', `import './y';`);
    touch('src/y.js');

    const tree = parseJS(`import './y';`);
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('relative');
    expect(out[0].specifier).toBe('./y');
    expect(out[0].targetPath).toBe('src/y.js');
    expect(out[0].confidence).toBe('EXTRACTED');
  });

  it('named imports: import { a, b } from "./y" -> 1 import', () => {
    const srcAbs = touch('src/a.js');
    touch('src/y.js');

    const tree = parseJS(`import { a, b } from './y';`);
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(1);
    expect(out[0].specifier).toBe('./y');
  });

  it('default + named from bare pkg: import x, { y } from "lodash" -> 1 bare', () => {
    const srcAbs = touch('src/a.js');

    const tree = parseJS(`import x, { y } from 'lodash';`);
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('bare');
    expect(out[0].targetPath).toBe('pkg:lodash');
  });

  it('namespace import: import * as ns from "./y" -> 1 import', () => {
    const srcAbs = touch('src/a.js');
    touch('src/y.js');

    const tree = parseJS(`import * as ns from './y';`);
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(1);
    expect(out[0].specifier).toBe('./y');
  });

  it('re-export: export { x } from "./y" -> 1 import', () => {
    const srcAbs = touch('src/a.js');
    touch('src/y.js');

    const tree = parseJS(`export { x } from './y';`);
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(1);
    expect(out[0].specifier).toBe('./y');
  });

  it('star re-export: export * from "./y" -> 1 import', () => {
    const srcAbs = touch('src/a.js');
    touch('src/y.js');

    const tree = parseJS(`export * from './y';`);
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(1);
    expect(out[0].specifier).toBe('./y');
  });

  it('commonjs: const x = require("./y") -> 1 import', () => {
    const srcAbs = touch('src/a.js');
    touch('src/y.js');

    const tree = parseJS(`const x = require('./y');`);
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(1);
    expect(out[0].specifier).toBe('./y');
    expect(out[0].targetPath).toBe('src/y.js');
  });

  it('dynamic: await import("./y") -> 1 import', () => {
    const srcAbs = touch('src/a.js');
    touch('src/y.js');

    const tree = parseJS(`async function f() { const m = await import('./y'); }`);
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(1);
    expect(out[0].specifier).toBe('./y');
  });

  it('three imports to the same target -> 1 deduped edge', () => {
    const srcAbs = touch('src/a.js');
    touch('src/y.js');

    const source = [
      `import './y';`,
      `import { z } from './y';`,
      `const r = require('./y');`,
    ].join('\n');
    const tree = parseJS(source);
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(1);
    // The first occurrence should win — the side-effect `import`.
    expect(out[0].specifier).toBe('./y');
  });

  it('empty file -> 0 imports (no whole-file fallback)', () => {
    const srcAbs = touch('src/a.js');
    const tree = parseJS(``);
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(0);
  });

  it('file with only plain code -> 0 imports', () => {
    const srcAbs = touch('src/a.js');
    const tree = parseJS(`const x = 1; function f() { return x + 2; }`);
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(0);
  });

  it('edgeId is deterministic across repeated calls with identical inputs', () => {
    const srcAbs = touch('src/a.js');
    touch('src/y.js');

    const tree1 = parseJS(`import { z } from './y';`);
    const tree2 = parseJS(`import { z } from './y';`);

    const a = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree: tree1,
      language: 'javascript',
    });
    const b = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree: tree2,
      language: 'javascript',
    });

    expect(a[0].edgeId).toBe(b[0].edgeId);
  });

  it('different srcFiles importing the same target -> different edgeIds', () => {
    const srcAAbs = touch('src/a.js');
    const srcBAbs = touch('src/b.js');
    touch('src/y.js');

    const tree = parseJS(`import './y';`);
    const fromA = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });
    const fromB = extractImports({
      filePath: 'src/b.js',
      absolutePath: srcBAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(fromA[0].targetPath).toBe(fromB[0].targetPath);
    expect(fromA[0].edgeId).not.toBe(fromB[0].edgeId);
  });

  it('edgeId matches the explicit computeNodeId/computeEdgeId formula', () => {
    const srcAbs = touch('src/a.js');
    touch('src/y.js');

    const tree = parseJS(`import './y';`);
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(1);
    const srcNodeId = computeNodeId('src/a.js', 'file', 'src/a.js');
    const dstNodeId = computeNodeId('src/y.js', 'file', 'src/y.js');
    const expected = computeEdgeId(srcNodeId, dstNodeId, 'IMPORTS');
    expect(out[0].edgeId).toBe(expected);
  });

  it('unresolved relative still emits an edge with the extensionless stub', () => {
    const srcAbs = touch('src/a.js');
    // Do NOT create `./missing`.

    const tree = parseJS(`import './missing';`);
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('relative');
    expect(out[0].targetPath).toBe('src/missing');
  });
});

// ─── FAKE-AST suite (runs even without tree-sitter installed) ───────────────

/**
 * Minimal hand-built node that matches the TSNode shape `extractImports`
 * reads. We only populate fields the extractor actually touches.
 */
interface FakeNode {
  type: string;
  text?: string;
  children?: FakeNode[];
  fields?: Record<string, FakeNode>;
}

/**
 * Wrap a `FakeNode` so it satisfies the `childCount` / `child()` /
 * `childForFieldName()` surface expected by the extractor. We build it as
 * a plain object so tests stay readable.
 */
function wrap(n: FakeNode): any {
  const children = n.children ?? [];
  const wrapped: any = {
    type: n.type,
    text: n.text,
    childCount: children.length,
    namedChildCount: children.length,
    child: (i: number) => (i < children.length ? wrap(children[i]) : null),
    namedChild: (i: number) => (i < children.length ? wrap(children[i]) : null),
    childForFieldName: (name: string) => {
      const f = n.fields?.[name];
      return f ? wrap(f) : null;
    },
    children: children.map(wrap),
  };
  return wrapped;
}

function stringLiteralNode(value: string): FakeNode {
  return { type: 'string', text: `'${value}'` };
}

function importStatement(spec: string): FakeNode {
  return {
    type: 'import_statement',
    fields: { source: stringLiteralNode(spec) },
  };
}

function exportStatement(spec: string): FakeNode {
  return {
    type: 'export_statement',
    fields: { source: stringLiteralNode(spec) },
  };
}

function requireCall(spec: string): FakeNode {
  return {
    type: 'call_expression',
    fields: {
      function: { type: 'identifier', text: 'require' },
      arguments: {
        type: 'arguments',
        children: [stringLiteralNode(spec)],
      },
    },
  };
}

function dynamicImport(spec: string): FakeNode {
  return {
    type: 'call_expression',
    fields: {
      function: { type: 'import', text: 'import' },
      arguments: {
        type: 'arguments',
        children: [stringLiteralNode(spec)],
      },
    },
  };
}

function program(...stmts: FakeNode[]): FakeNode {
  return { type: 'program', children: stmts };
}

describe('extractImports (synthetic AST — structural coverage)', () => {
  it('import statement with source field -> 1 import', () => {
    const srcAbs = touch('src/a.js');
    touch('src/y.js');

    const tree = { rootNode: wrap(program(importStatement('./y'))) };
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(1);
    expect(out[0].specifier).toBe('./y');
    expect(out[0].kind).toBe('relative');
    expect(out[0].targetPath).toBe('src/y.js');
  });

  it('bare import: "lodash" -> pkg:lodash', () => {
    const srcAbs = touch('src/a.js');

    const tree = { rootNode: wrap(program(importStatement('lodash'))) };
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('bare');
    expect(out[0].targetPath).toBe('pkg:lodash');
  });

  it('re-export statement counts as an import', () => {
    const srcAbs = touch('src/a.js');
    touch('src/y.js');

    const tree = { rootNode: wrap(program(exportStatement('./y'))) };
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(1);
  });

  it('require() call emits an import', () => {
    const srcAbs = touch('src/a.js');
    touch('src/y.js');

    const tree = { rootNode: wrap(program(requireCall('./y'))) };
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(1);
    expect(out[0].targetPath).toBe('src/y.js');
  });

  it('dynamic import() call emits an import', () => {
    const srcAbs = touch('src/a.js');
    touch('src/y.js');

    const tree = { rootNode: wrap(program(dynamicImport('./y'))) };
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(1);
    expect(out[0].targetPath).toBe('src/y.js');
  });

  it('three imports to same target -> deduped to 1', () => {
    const srcAbs = touch('src/a.js');
    touch('src/y.js');

    const tree = {
      rootNode: wrap(
        program(importStatement('./y'), requireCall('./y'), dynamicImport('./y')),
      ),
    };
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(1);
    // First-occurrence-wins is important for the de-dup semantics —
    // a re-scan that would later produce duplicates should not shuffle
    // the reported specifier.
    expect(out[0].specifier).toBe('./y');
  });

  it('no imports -> empty result', () => {
    const srcAbs = touch('src/a.js');

    const tree = { rootNode: wrap(program()) };
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(0);
  });

  it('export without source (plain `export const x`) is ignored', () => {
    const srcAbs = touch('src/a.js');

    const exportNoSource: FakeNode = { type: 'export_statement' };
    const tree = { rootNode: wrap(program(exportNoSource)) };
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(0);
  });

  it('call_expression that is not require/import is ignored', () => {
    const srcAbs = touch('src/a.js');

    const unrelated: FakeNode = {
      type: 'call_expression',
      fields: {
        function: { type: 'identifier', text: 'doThing' },
        arguments: { type: 'arguments', children: [stringLiteralNode('./y')] },
      },
    };
    const tree = { rootNode: wrap(program(unrelated)) };
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(0);
  });

  it('require() with non-string-literal arg is ignored (dynamic specifier)', () => {
    const srcAbs = touch('src/a.js');

    const dynamicSpec: FakeNode = {
      type: 'call_expression',
      fields: {
        function: { type: 'identifier', text: 'require' },
        arguments: {
          type: 'arguments',
          children: [{ type: 'identifier', text: 'mod' }],
        },
      },
    };
    const tree = { rootNode: wrap(program(dynamicSpec)) };
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(out).toHaveLength(0);
  });

  it('edgeId is deterministic across repeated extract() calls', () => {
    const srcAbs = touch('src/a.js');
    touch('src/y.js');

    const mkTree = () => ({ rootNode: wrap(program(importStatement('./y'))) });
    const a = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree: mkTree(),
      language: 'javascript',
    });
    const b = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree: mkTree(),
      language: 'javascript',
    });

    expect(a[0].edgeId).toBe(b[0].edgeId);
  });

  it('different srcFiles to same target -> different edgeIds (srcFile in hash)', () => {
    const srcAAbs = touch('src/a.js');
    const srcBAbs = touch('src/b.js');
    touch('src/y.js');

    const tree = { rootNode: wrap(program(importStatement('./y'))) };
    const fromA = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });
    const fromB = extractImports({
      filePath: 'src/b.js',
      absolutePath: srcBAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    expect(fromA[0].targetPath).toBe(fromB[0].targetPath);
    expect(fromA[0].edgeId).not.toBe(fromB[0].edgeId);
  });

  it('edgeId matches the explicit computeNodeId/computeEdgeId formula', () => {
    const srcAbs = touch('src/a.js');
    touch('src/y.js');

    const tree = { rootNode: wrap(program(importStatement('./y'))) };
    const out = extractImports({
      filePath: 'src/a.js',
      absolutePath: srcAbs,
      repoRoot: tmpRoot,
      tree,
      language: 'javascript',
    });

    const srcNodeId = computeNodeId('src/a.js', 'file', 'src/a.js');
    const dstNodeId = computeNodeId('src/y.js', 'file', 'src/y.js');
    const expected = computeEdgeId(srcNodeId, dstNodeId, 'IMPORTS');
    expect(out[0].edgeId).toBe(expected);
  });
});
