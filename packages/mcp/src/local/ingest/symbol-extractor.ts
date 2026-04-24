/**
 * Symbol extraction for local-mode MCP ingestion (Phase 11 Wave 2, L7).
 *
 * Takes a parsed tree-sitter tree plus the chunks produced by `chunkFile`
 * and returns one `ExtractedSymbol` per named chunkable node. Each symbol
 * carries:
 *   - `chunkId`: the chunk whose span contains the symbol (for join with
 *     `code_chunks.id`).
 *   - `nodeId`: `computeNodeId(filePath, kind, qualified)`, using the
 *     Wave 1 deterministic-id util so the ID matches what the remote
 *     backend would compute for the same symbol.
 *
 * Kinds emitted:
 *   - 'class'         → `class Foo {...}`
 *   - 'function'      → `function foo() {}`, `function* foo() {}`, or
 *                        top-level `const foo = () => {}` / `= function(){}`
 *   - 'method'        → `class Foo { bar() {} }` (qualified: `Foo.bar`)
 *   - 'constructor'   → `class Foo { constructor() {} }`
 *   - 'interface'     → `interface I {}` (TS)
 *   - 'type'          → `type T = ...` (TS)
 *
 * DESIGN DECISIONS (mirrors chunker):
 *   - Methods inside an ANONYMOUS class (`const C = class { m(){} }`)
 *     are SKIPPED — the chunker doesn't produce chunks for them either,
 *     so there's no chunkId to anchor them to. The enclosing `const C`
 *     variable declaration is itself emitted as a `function` symbol.
 *   - Anonymous functions (IIFEs, callbacks, arrow bodies) are NOT
 *     emitted — they have no identifier.
 *
 * Pure function, no DI. Never mutates the input tree.
 */

import { computeNodeId } from '../deterministic-ids';
import type { Chunk } from './chunker';

// Minimal structural tree-sitter types — matches chunker.ts.
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

export interface ExtractedSymbol {
  /** ID of the chunk whose line span contains this symbol. */
  chunkId: string;
  /** `computeNodeId(filePath, kind, qualified)`. */
  nodeId: string;
  /** 'class' | 'function' | 'method' | 'constructor' | 'interface' | 'type'. */
  kind: string;
  /** Simple identifier (e.g. 'bar' for 'Foo.bar'). */
  name: string;
  /** For methods: `ClassName.methodName`. Otherwise same as `name`. */
  qualified: string;
}

export interface ExtractSymbolsInput {
  filePath: string;
  chunks: Chunk[];
  tree: TSTree;
}

export function extractSymbols(input: ExtractSymbolsInput): ExtractedSymbol[] {
  const { filePath, chunks, tree } = input;
  const symbols: ExtractedSymbol[] = [];
  const rootNode = tree?.rootNode;
  if (!rootNode || !Array.isArray(rootNode.children)) {
    return symbols;
  }

  for (const child of rootNode.children) {
    walkForSymbols(child, symbols, filePath, chunks);
  }

  return symbols;
}

function walkForSymbols(
  node: TSNode,
  out: ExtractedSymbol[],
  filePath: string,
  chunks: Chunk[],
): void {
  const t = node.type;

  if (t === 'class_declaration') {
    const name = identifierName(node, 'name');
    if (!name) return;
    pushSymbol(out, filePath, chunks, node, 'class', name, name);

    const body = safeChildForField(node, 'body');
    if (body && Array.isArray(body.children)) {
      for (const bodyChild of body.children) {
        if (bodyChild.type !== 'method_definition') continue;
        const methodName = methodPropertyName(bodyChild);
        if (!methodName) continue;
        const kind = methodName === 'constructor' ? 'constructor' : 'method';
        pushSymbol(
          out,
          filePath,
          chunks,
          bodyChild,
          kind,
          methodName,
          `${name}.${methodName}`,
        );
      }
    }
    return;
  }

  if (t === 'function_declaration' || t === 'generator_function_declaration') {
    const name = identifierName(node, 'name');
    if (!name) return;
    pushSymbol(out, filePath, chunks, node, 'function', name, name);
    return;
  }

  if (t === 'interface_declaration') {
    const name = identifierName(node, 'name');
    if (!name) return;
    pushSymbol(out, filePath, chunks, node, 'interface', name, name);
    return;
  }

  if (t === 'type_alias_declaration') {
    const name = identifierName(node, 'name');
    if (!name) return;
    pushSymbol(out, filePath, chunks, node, 'type', name, name);
    return;
  }

  if (t === 'lexical_declaration' || t === 'variable_declaration') {
    const declarators = (node.children || []).filter(
      (c) => c.type === 'variable_declarator',
    );
    for (const decl of declarators) {
      const nameNode = safeChildForField(decl, 'name');
      const valueNode = safeChildForField(decl, 'value');
      if (!nameNode || nameNode.type !== 'identifier') continue;
      if (!valueNode) continue;
      if (valueNode.type !== 'arrow_function' && valueNode.type !== 'function_expression') {
        continue;
      }
      const name = nameNode.text;
      if (!name) continue;
      // The chunk for this declarator is the one that covers the full
      // lexical_declaration span — that's what the chunker emitted.
      pushSymbol(out, filePath, chunks, node, 'function', name, name);
      return;
    }
    return;
  }

  if (t === 'export_statement') {
    for (const child of node.children || []) {
      walkForSymbols(child, out, filePath, chunks);
    }
    return;
  }
}

function pushSymbol(
  out: ExtractedSymbol[],
  filePath: string,
  chunks: Chunk[],
  node: TSNode,
  kind: string,
  name: string,
  qualified: string,
): void {
  const lineStart = node.startPosition.row + 1;
  const lineEnd = node.endPosition.row + 1;
  const chunkId = chunkIdForSpan(chunks, lineStart, lineEnd, qualified, kind);
  if (!chunkId) return; // No containing chunk — symbol is orphaned, skip.
  const nodeId = computeNodeId(filePath, kind, qualified);
  out.push({ chunkId, nodeId, kind, name, qualified });
}

/**
 * Pick the chunk whose span contains `[lineStart, lineEnd]`. If multiple
 * chunks contain the span (e.g. a method is contained in its class chunk
 * AND has its own method chunk), prefer the one whose `symbolName` +
 * `symbolKind` match. If no exact-name match, prefer the tightest span
 * (smallest lineEnd - lineStart).
 */
function chunkIdForSpan(
  chunks: Chunk[],
  lineStart: number,
  lineEnd: number,
  qualified: string,
  kind: string,
): string | null {
  // First: direct match on (symbolKind, symbolName).
  for (const c of chunks) {
    if (
      c.symbolKind === kind &&
      (c.symbolName === qualified || c.symbolName === simpleName(qualified))
    ) {
      return c.chunkId;
    }
  }

  // Second: look for a chunk whose name matches the simple tail of the
  // qualified name (e.g. `Foo.bar` → simple name `bar`).
  const simple = simpleName(qualified);
  for (const c of chunks) {
    if (c.symbolKind === kind && c.symbolName === simple) {
      return c.chunkId;
    }
  }

  // Third: smallest-span containment.
  let best: Chunk | null = null;
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
  return nameNode.text || null;
}

function methodPropertyName(methodNode: TSNode): string | null {
  const nameNode = safeChildForField(methodNode, 'name');
  if (!nameNode) return null;
  if (
    nameNode.type === 'property_identifier' ||
    nameNode.type === 'private_property_identifier'
  ) {
    return nameNode.text || null;
  }
  return null;
}
