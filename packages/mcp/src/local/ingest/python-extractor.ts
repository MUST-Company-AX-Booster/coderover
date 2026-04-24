/**
 * Phase 11 Wave 4 — L20: Python symbol + import extractor.
 *
 * Mirrors the shape of the JS extractors (`symbol-extractor.ts`,
 * `import-extractor.ts`) so downstream code that already knows how to
 * consume `ExtractedSymbol[]` / `ExtractedImport[]` works unchanged. We
 * DO NOT re-declare those types here — we import them from the Wave 2
 * files — so any invariant added there (e.g. a new field) lands in
 * Python automatically.
 *
 * ### Node-type cheat sheet (tree-sitter-python)
 *
 *   class_definition        ← `class Foo: ...`
 *     fields: name, superclasses?, body
 *   function_definition     ← `def foo(): ...` and `async def foo(): ...`
 *     fields: name, parameters, body, return_type?
 *   decorated_definition    ← wraps a class_definition or function_definition
 *                              that has one or more `@decorator` lines above
 *     fields: definition
 *   import_statement        ← `import foo` / `import foo.bar` /
 *                              `import foo as bar` / `import foo, bar`
 *     children: dotted_name / aliased_import
 *   import_from_statement   ← `from foo.bar import x, y` /
 *                              `from . import x` / `from .foo import y` /
 *                              `from ..foo.bar import z`
 *     fields: module_name? (dotted_name | relative_import), name (wildcard / ...)
 *
 * ### Design notes
 *
 *   - `decorated_definition` is awkward because its kind is determined by
 *     the wrapped definition. We handle it by unwrapping: walk one level
 *     to the inner `function_definition` / `class_definition` and treat
 *     that as the effective node (preserving the decorator's start line
 *     for span purposes via the outer node's positions is overkill — the
 *     chunker hasn't been extended to Python either, so for Wave 4's
 *     scope we just extract symbols relative to the inner definition).
 *
 *   - `async def` parses as a `function_definition` whose first child is
 *     `async` (an unnamed terminal). No dedicated `async_function_def`
 *     node in tree-sitter-python. We therefore don't branch on async.
 *
 *   - Methods: Python has no dedicated `method_definition` — a method is
 *     a `function_definition` whose parent's parent is a `class_definition`
 *     (parent chain: function_definition → block → class_definition).
 *     We detect that via `findEnclosingClass` and emit with qualified
 *     `Class.method`.
 *
 *   - Relative imports: `from .sibling import X` is RELATIVE. tree-sitter
 *     emits the module name as a `relative_import` node whose own children
 *     contain one or more `import_prefix` tokens (".") plus an optional
 *     `dotted_name`. `.` → one level up of the module path, `..` → two,
 *     etc. We reconstruct a path using the src file's directory.
 *
 *   - Python relative resolution is "best effort". If the resolved path
 *     doesn't exist on disk we still emit the edge with the extensionless
 *     stub — same pattern as `import-resolver.ts` for JS.
 */

import * as fs from 'fs';
import * as path from 'path';

import { computeEdgeId, computeNodeId } from '../deterministic-ids';
import type { ExtractedImport } from './import-extractor';
import type { ExtractedSymbol, ExtractSymbolsInput } from './symbol-extractor';

// Minimal structural tree-sitter types — matches Wave 2 extractors. Keeping
// these local avoids pulling in `tree-sitter` typings just to walk nodes.
interface TSPoint {
  row: number;
  column: number;
}

interface TSNode {
  type: string;
  text: string;
  startPosition: TSPoint;
  endPosition: TSPoint;
  children: TSNode[];
  namedChildren?: TSNode[];
  parent?: TSNode | null;
  hasError?: boolean;
  childForFieldName?: (fieldName: string) => TSNode | null;
  childCount?: number;
  child?: (i: number) => TSNode | null;
}

interface TSTree {
  rootNode: TSNode;
}

export interface ExtractPythonImportsInput {
  filePath: string;
  absolutePath: string;
  repoRoot: string;
  tree: TSTree;
}

/**
 * Walk the tree and emit one `ExtractedSymbol` per named class / function /
 * method. Methods get qualified `Class.method`; free functions just use the
 * simple name.
 *
 * Never throws: bad input → empty array + `console.warn`.
 */
export function extractPythonSymbols(
  input: ExtractSymbolsInput,
): ExtractedSymbol[] {
  const { filePath, chunks, tree } = input;
  const symbols: ExtractedSymbol[] = [];
  try {
    const rootNode = tree?.rootNode;
    if (!rootNode) return symbols;

    const visit = (node: TSNode): void => {
      if (!node) return;

      // Unwrap decorated_definition — its kind is determined by the wrapped
      // definition. We descend to the inner node and treat it as authoritative.
      if (node.type === 'decorated_definition') {
        const inner = safeChildForField(node, 'definition');
        if (inner) visit(inner);
        // Still descend into the decorator list / inner node's body so
        // nested defs and classes are picked up.
        for (const c of node.children || []) visit(c);
        return;
      }

      if (node.type === 'class_definition') {
        const className = identifierName(node, 'name');
        if (className) {
          pushSymbol(symbols, filePath, chunks, node, 'class', className, className);

          // Walk the class body for methods. The body is a `block` whose
          // direct children are statements; we care about function_definition
          // and decorated_definition (unwrapped) children.
          const body = safeChildForField(node, 'body');
          if (body && Array.isArray(body.children)) {
            for (const bodyChild of body.children) {
              collectClassMethod(bodyChild, className, symbols, filePath, chunks);
            }
          }
        }
        return;
      }

      if (node.type === 'function_definition') {
        // Top-level function (not inside a class). If it's inside a class
        // we've already emitted it above; `findEnclosingClass` guards us
        // against double-emitting.
        const enclosingClass = findEnclosingClass(node);
        if (enclosingClass) return;
        const fnName = identifierName(node, 'name');
        if (!fnName) return;
        pushSymbol(symbols, filePath, chunks, node, 'function', fnName, fnName);
        return;
      }

      // Recurse — Python can nest definitions arbitrarily (e.g. a function
      // inside a function). For Wave 4 we only emit top-level + class
      // methods, same signal/noise ratio as the JS extractor.
      for (const c of node.children || []) visit(c);
    };

    for (const c of rootNode.children || []) visit(c);
  } catch (err) {
    console.warn(
      `[python-extractor] symbol extraction failed for ${input.filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return symbols;
}

function collectClassMethod(
  bodyChild: TSNode,
  className: string,
  out: ExtractedSymbol[],
  filePath: string,
  chunks: ExtractSymbolsInput['chunks'],
): void {
  let fnNode: TSNode | null = null;
  if (bodyChild.type === 'function_definition') {
    fnNode = bodyChild;
  } else if (bodyChild.type === 'decorated_definition') {
    const inner = safeChildForField(bodyChild, 'definition');
    if (inner && inner.type === 'function_definition') fnNode = inner;
  }
  if (!fnNode) return;

  const methodName = identifierName(fnNode, 'name');
  if (!methodName) return;
  const qualified = `${className}.${methodName}`;
  // Python has no first-class constructor — `__init__` is a regular method.
  // We keep kind 'method' uniformly; callers that care about constructors
  // can match on name.
  pushSymbol(out, filePath, chunks, fnNode, 'method', methodName, qualified);
}

/**
 * Walk the tree and emit `ExtractedImport`s for every `import` /
 * `from ... import` statement. Bare imports (`import foo`) use `pkg:` —
 * Python modules from third-party packages look the same syntactically so
 * we treat them as bare unless the name starts with `.`, in which case we
 * do best-effort relative resolution.
 *
 * Never throws: bad input → empty array + `console.warn`.
 */
export function extractPythonImports(
  input: ExtractPythonImportsInput,
): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  const seenTargets = new Set<string>();
  try {
    const rootNode = input.tree?.rootNode;
    if (!rootNode) return out;

    const visit = (node: TSNode | null | undefined): void => {
      if (!node) return;

      if (node.type === 'import_statement') {
        // `import foo` / `import foo.bar` / `import foo as bar, baz`.
        // Each module spec is either a `dotted_name` or an `aliased_import`.
        for (const c of node.children || []) {
          if (c.type === 'dotted_name') {
            emitBareImport(out, seenTargets, input, textOf(c));
          } else if (c.type === 'aliased_import') {
            // `import foo as bar` — the module is still `foo` from the
            // dependency standpoint; the alias is irrelevant to the edge.
            const moduleNode = safeChildForField(c, 'name');
            if (moduleNode && moduleNode.type === 'dotted_name') {
              emitBareImport(out, seenTargets, input, textOf(moduleNode));
            }
          }
        }
        return;
      }

      if (node.type === 'import_from_statement') {
        // `from foo.bar import x, y` / `from .sibling import x` / `from .. import m`.
        // tree-sitter puts the module at field `module_name`.
        const moduleNode = safeChildForField(node, 'module_name');
        if (!moduleNode) {
          // Defensive: some grammars emit a bare `from . import x` with no
          // `module_name` field. Walk children looking for relative_import.
          const rel = (node.children || []).find(
            (c) => c.type === 'relative_import',
          );
          if (rel) handleRelativeImport(rel, out, seenTargets, input);
          return;
        }

        if (moduleNode.type === 'relative_import') {
          handleRelativeImport(moduleNode, out, seenTargets, input);
        } else if (moduleNode.type === 'dotted_name') {
          emitBareImport(out, seenTargets, input, textOf(moduleNode));
        }
        return;
      }

      for (const c of node.children || []) visit(c);
    };

    visit(rootNode);
  } catch (err) {
    console.warn(
      `[python-extractor] import extraction failed for ${input.filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return out;
}

/**
 * Emit a bare (external / std-lib) import edge, e.g. `import foo.bar` /
 * `from foo.bar import x`. The target path gets the `pkg:` prefix so
 * downstream queries can cheaply distinguish it from in-repo paths.
 */
function emitBareImport(
  out: ExtractedImport[],
  seenTargets: Set<string>,
  input: ExtractPythonImportsInput,
  moduleName: string,
): void {
  if (!moduleName) return;
  const targetPath = `pkg:${moduleName}`;
  if (seenTargets.has(targetPath)) return;
  seenTargets.add(targetPath);

  const srcNodeId = computeNodeId(input.filePath, 'file', input.filePath);
  const dstNodeId = computeNodeId(targetPath, 'file', targetPath);
  out.push({
    edgeId: computeEdgeId(srcNodeId, dstNodeId, 'IMPORTS'),
    srcFile: input.filePath,
    targetPath,
    specifier: moduleName,
    kind: 'bare',
    confidence: 'EXTRACTED',
  });
}

/**
 * `from .sibling import X` / `from ..parent.mod import Y`.
 *
 * The `relative_import` node is something like:
 *   relative_import
 *     import_prefix "."     (one per dot)
 *     import_prefix "."
 *     dotted_name "parent.mod"   (optional — could be missing if `from . import x`)
 *
 * We count the dots and reconstruct the filesystem path:
 *   1 dot  = same dir as srcFile
 *   2 dots = parent dir
 *   N dots = N-1 levels up
 *
 * Best-effort: if the resolved path isn't on disk we still emit the edge
 * with the extensionless stub so Wave 3's `find_dependencies` can LIKE-match
 * it against files that get created later (same policy as
 * `import-resolver.ts` for JS relative imports).
 */
function handleRelativeImport(
  relNode: TSNode,
  out: ExtractedImport[],
  seenTargets: Set<string>,
  input: ExtractPythonImportsInput,
): void {
  const kids = relNode.children || [];
  let dots = 0;
  let dottedName = '';
  for (const k of kids) {
    if (k.type === 'import_prefix') {
      // `import_prefix` text is the literal dots — ".", "..", etc. Count
      // the number of dot characters to handle both shapes.
      dots += (k.text || '').length;
    } else if (k.type === 'dotted_name') {
      dottedName = textOf(k);
    }
  }
  if (dots === 0) {
    // Shouldn't happen — a relative_import without dots — but handle
    // gracefully by re-routing as bare.
    if (dottedName) {
      emitBareImport(out, seenTargets, input, dottedName);
    }
    return;
  }

  // Build the repo-relative resolved target. Start from the src file's
  // directory (absolutePath's dirname), walk up `dots - 1` levels, then
  // append the dotted name turned into a path.
  const srcDir = path.dirname(input.absolutePath);
  const levelsUp = Math.max(0, dots - 1);
  let anchorDir = srcDir;
  for (let i = 0; i < levelsUp; i++) {
    anchorDir = path.dirname(anchorDir);
  }
  const relTail = dottedName ? dottedName.replace(/\./g, '/') : '';
  const candidateAbs = relTail
    ? path.join(anchorDir, relTail)
    : anchorDir;

  const probed = probePython(candidateAbs);
  const resolvedAbs = probed ?? candidateAbs;
  const targetPath = toRepoRelativeOrAbsolute(resolvedAbs, input.repoRoot);

  if (seenTargets.has(targetPath)) return;
  seenTargets.add(targetPath);

  const srcNodeId = computeNodeId(input.filePath, 'file', input.filePath);
  const dstNodeId = computeNodeId(targetPath, 'file', targetPath);
  const specifier = `${'.'.repeat(dots)}${dottedName}`;
  out.push({
    edgeId: computeEdgeId(srcNodeId, dstNodeId, 'IMPORTS'),
    srcFile: input.filePath,
    targetPath,
    specifier,
    kind: 'relative',
    confidence: 'EXTRACTED',
  });
}

/**
 * Try `<candidate>.py`, `<candidate>.pyw`, or `<candidate>/__init__.py`.
 * Returns the first absolute path that exists, or `null`.
 */
function probePython(candidate: string): string | null {
  const withPy = candidate + '.py';
  if (existsFile(withPy)) return withPy;
  const withPyw = candidate + '.pyw';
  if (existsFile(withPyw)) return withPyw;
  const pkgInit = path.join(candidate, '__init__.py');
  if (existsFile(pkgInit)) return pkgInit;
  return null;
}

function existsFile(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Convert an absolute path to its repo-relative POSIX form when it lies
 * inside `repoRoot`; otherwise keep the absolute form. Mirrors the JS
 * resolver's behaviour so downstream storage is consistent across languages.
 */
function toRepoRelativeOrAbsolute(absolutePath: string, repoRoot: string): string {
  const normalisedRoot = path.resolve(repoRoot);
  const normalisedTarget = path.resolve(absolutePath);
  const rel = path.relative(normalisedRoot, normalisedTarget);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return normalisedTarget;
  }
  return rel.split(path.sep).join('/');
}

// ─── Shared helpers (local copies — keep this module standalone) ───────────

function safeChildForField(node: TSNode, field: string): TSNode | null {
  if (typeof node.childForFieldName === 'function') {
    try {
      return node.childForFieldName(field) ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

function identifierName(node: TSNode, field: string): string | null {
  const nameNode = safeChildForField(node, field);
  if (!nameNode) return null;
  const text = nameNode.text;
  return text || null;
}

function textOf(node: TSNode): string {
  return node.text || '';
}

function findEnclosingClass(node: TSNode): TSNode | null {
  let current = node.parent ?? null;
  while (current) {
    if (current.type === 'class_definition') return current;
    current = current.parent ?? null;
  }
  return null;
}

function pushSymbol(
  out: ExtractedSymbol[],
  filePath: string,
  chunks: ExtractSymbolsInput['chunks'],
  node: TSNode,
  kind: string,
  name: string,
  qualified: string,
): void {
  const lineStart = node.startPosition.row + 1;
  const lineEnd = node.endPosition.row + 1;
  const chunkId = chunkIdForSpan(chunks, lineStart, lineEnd, qualified, kind);
  if (!chunkId) return;
  const nodeId = computeNodeId(filePath, kind, qualified);
  out.push({ chunkId, nodeId, kind, name, qualified });
}

/**
 * Pick a chunk whose span contains the given line range. Same heuristic as
 * `symbol-extractor.ts#chunkIdForSpan` — prefer a matching (kind, name),
 * then a matching simple-name, then the tightest containing span.
 */
function chunkIdForSpan(
  chunks: ExtractSymbolsInput['chunks'],
  lineStart: number,
  lineEnd: number,
  qualified: string,
  kind: string,
): string | null {
  for (const c of chunks) {
    if (
      c.symbolKind === kind &&
      (c.symbolName === qualified || c.symbolName === simpleName(qualified))
    ) {
      return c.chunkId;
    }
  }
  const simple = simpleName(qualified);
  for (const c of chunks) {
    if (c.symbolKind === kind && c.symbolName === simple) return c.chunkId;
  }
  let best: ExtractSymbolsInput['chunks'][number] | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const c of chunks) {
    if (c.lineStart <= lineStart && c.lineEnd >= lineEnd) {
      const span = c.lineEnd - c.lineStart;
      if (span < bestSpan) {
        bestSpan = span;
        best = c;
      }
    }
  }
  return best?.chunkId ?? null;
}

function simpleName(qualified: string): string {
  const dot = qualified.lastIndexOf('.');
  return dot >= 0 ? qualified.slice(dot + 1) : qualified;
}
