/**
 * Phase 11 Wave 4 — L20: Java symbol + import extractor.
 *
 * Mirrors the JS/Python/Go extractor shape.
 *
 * ### Node-type cheat sheet (tree-sitter-java)
 *
 *   class_declaration        ← `class Foo {}`
 *     fields: name, superclass?, interfaces?, body
 *   interface_declaration    ← `interface I {}`
 *     fields: name, body
 *   enum_declaration         ← `enum E { A, B }`
 *     fields: name, body
 *   record_declaration       ← `record R(int x) {}` (Java 14+)
 *     fields: name, parameters, body
 *   method_declaration       ← `void bar() {}`
 *     fields: modifiers?, type, name, parameters, body
 *   constructor_declaration  ← `Foo() {}`
 *     fields: modifiers?, name, parameters, body
 *   import_declaration       ← `import java.util.List;` /
 *                               `import static java.util.Arrays.asList;` /
 *                               `import java.util.*;`
 *     children: "import" keyword, optional "static" keyword,
 *               scoped_identifier / asterisk
 *   package_declaration      ← `package com.example;` — NOT an import.
 *
 * ### Design notes
 *
 *   - Method qualified name: walk up the parent chain to the nearest
 *     class/interface/enum/record declaration. That's the enclosing type.
 *     Nested classes → use the innermost wrapper. If none found, emit the
 *     simple name as qualified (defensive; shouldn't happen in valid Java).
 *   - Constructor qualified name: `ClassName.ClassName` per spec.
 *   - `import static Foo.Bar.baz;` — the `static` modifier and the
 *     trailing `.baz` are both irrelevant to the dependency edge. We take
 *     the full scoped identifier (`Foo.Bar.baz`) as the target, matching
 *     the backend's behaviour.
 *   - Star imports `import java.util.*;` — emit with specifier
 *     `java.util.*`; downstream joins handle the wildcard the same way.
 *   - Records are treated as classes (closest match in the extractor's
 *     kind taxonomy; the chunker's Java support isn't implemented for
 *     Wave 4 but if/when it is we'd want a `record` symbol kind).
 */

import { computeEdgeId, computeNodeId } from '../deterministic-ids';
import type { ExtractedImport } from './import-extractor';
import type { ExtractedSymbol, ExtractSymbolsInput } from './symbol-extractor';

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
}

interface TSTree {
  rootNode: TSNode;
}

export interface ExtractJavaImportsInput {
  filePath: string;
  absolutePath: string;
  repoRoot: string;
  tree: TSTree;
}

/**
 * Emit symbols for every class / interface / enum / method / constructor.
 * Nested types are supported — the visitor recurses into class/interface/
 * enum bodies.
 */
export function extractJavaSymbols(input: ExtractSymbolsInput): ExtractedSymbol[] {
  const { filePath, chunks, tree } = input;
  const symbols: ExtractedSymbol[] = [];
  try {
    const rootNode = tree?.rootNode;
    if (!rootNode) return symbols;

    const visit = (node: TSNode): void => {
      if (!node) return;

      if (node.type === 'class_declaration') {
        handleTypeDecl(node, 'class', symbols, filePath, chunks);
        return;
      }
      if (node.type === 'interface_declaration') {
        handleTypeDecl(node, 'interface', symbols, filePath, chunks);
        return;
      }
      if (node.type === 'enum_declaration') {
        handleTypeDecl(node, 'enum', symbols, filePath, chunks);
        return;
      }
      if (node.type === 'record_declaration') {
        // Record is a restricted class — emit as 'class' to keep the kind
        // taxonomy simple for Wave 4.
        handleTypeDecl(node, 'class', symbols, filePath, chunks);
        return;
      }

      // Walk into every other node so nested types inside e.g. package
      // declarations or annotations are still found.
      for (const c of node.children || []) visit(c);
    };

    for (const c of rootNode.children || []) visit(c);
  } catch (err) {
    console.warn(
      `[java-extractor] symbol extraction failed for ${input.filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return symbols;
}

function handleTypeDecl(
  node: TSNode,
  kind: 'class' | 'interface' | 'enum',
  out: ExtractedSymbol[],
  filePath: string,
  chunks: ExtractSymbolsInput['chunks'],
): void {
  const name = identifierName(node, 'name');
  if (!name) return;
  pushSymbol(out, filePath, chunks, node, kind, name, name);

  // Emit each method / constructor / nested-type inside the body.
  const body = safeChildForField(node, 'body');
  if (!body) return;
  for (const bodyChild of body.children || []) {
    collectMember(bodyChild, name, out, filePath, chunks);
  }
}

function collectMember(
  child: TSNode,
  enclosingTypeName: string,
  out: ExtractedSymbol[],
  filePath: string,
  chunks: ExtractSymbolsInput['chunks'],
): void {
  if (child.type === 'method_declaration') {
    const methodName = identifierName(child, 'name');
    if (!methodName) return;
    pushSymbol(
      out,
      filePath,
      chunks,
      child,
      'method',
      methodName,
      `${enclosingTypeName}.${methodName}`,
    );
    return;
  }
  if (child.type === 'constructor_declaration') {
    const ctorName = identifierName(child, 'name') ?? enclosingTypeName;
    pushSymbol(
      out,
      filePath,
      chunks,
      child,
      'constructor',
      ctorName,
      `${enclosingTypeName}.${ctorName}`,
    );
    return;
  }
  // Nested types.
  if (child.type === 'class_declaration') {
    handleTypeDecl(child, 'class', out, filePath, chunks);
    return;
  }
  if (child.type === 'interface_declaration') {
    handleTypeDecl(child, 'interface', out, filePath, chunks);
    return;
  }
  if (child.type === 'enum_declaration') {
    handleTypeDecl(child, 'enum', out, filePath, chunks);
    return;
  }
  if (child.type === 'record_declaration') {
    handleTypeDecl(child, 'class', out, filePath, chunks);
    return;
  }
  // Field declarations, enum constants, etc. — not emitted in Wave 4.
}

/**
 * Walk the tree and emit one bare import per `import_declaration`.
 * `package com.example;` is explicitly NOT an import.
 */
export function extractJavaImports(
  input: ExtractJavaImportsInput,
): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  const seen = new Set<string>();
  try {
    const rootNode = input.tree?.rootNode;
    if (!rootNode) return out;

    for (const c of rootNode.children || []) {
      if (c.type !== 'import_declaration') continue;
      handleImportDecl(c, out, seen, input);
    }
  } catch (err) {
    console.warn(
      `[java-extractor] import extraction failed for ${input.filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return out;
}

function handleImportDecl(
  node: TSNode,
  out: ExtractedImport[],
  seen: Set<string>,
  input: ExtractJavaImportsInput,
): void {
  // The relevant payload is the `scoped_identifier` (or an identifier +
  // `.*`). Walk named children, concatenating the first scoped_identifier /
  // identifier we find and appending `.*` if an `asterisk` sibling is
  // present. This handles:
  //   import java.util.List;                -> java.util.List
  //   import static java.util.Arrays.asList; -> java.util.Arrays.asList
  //   import java.util.*;                   -> java.util.*
  let base = '';
  let hasStar = false;
  for (const c of node.children || []) {
    if (c.type === 'scoped_identifier' || c.type === 'identifier') {
      if (!base) base = (c.text || '').trim();
    } else if (c.type === 'asterisk' || c.text === '*') {
      hasStar = true;
    }
  }
  if (!base) return;

  const specifier = hasStar ? `${base}.*` : base;
  const targetPath = `pkg:${specifier}`;
  if (seen.has(targetPath)) return;
  seen.add(targetPath);

  const srcNodeId = computeNodeId(input.filePath, 'file', input.filePath);
  const dstNodeId = computeNodeId(targetPath, 'file', targetPath);
  out.push({
    edgeId: computeEdgeId(srcNodeId, dstNodeId, 'IMPORTS'),
    srcFile: input.filePath,
    targetPath,
    specifier,
    kind: 'bare',
    confidence: 'EXTRACTED',
  });
}

// ─── Shared helpers (local copies) ──────────────────────────────────────────

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
