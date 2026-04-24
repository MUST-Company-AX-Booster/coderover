/**
 * AST-driven chunker for local-mode MCP ingestion (Phase 11 Wave 2, L6).
 *
 * Input: a parsed tree-sitter tree + the original source text.
 * Output: a list of `Chunk` records suitable for insertion into `code_chunks`.
 *
 * Strategy (JS/TS only for Wave 2):
 *   - Walk the AST top-down, emitting one chunk per "chunkable" named node
 *     (classes, functions, methods, top-level const/let = arrow/function).
 *   - Each chunkable node produces exactly ONE chunk covering its full
 *     `startPosition.row`..`endPosition.row` span (1-indexed, inclusive).
 *   - A class AND each of its methods produce separate chunks (see
 *     DESIGN DECISIONS below for rationale).
 *   - If no chunkable nodes match (empty file, import-only file, etc.),
 *     emit ONE whole-file chunk so the file is still indexable.
 *   - Trees with `rootNode.hasError === true` still emit the file-level
 *     chunk — a partially-broken file is better indexed than unindexed.
 *
 * DESIGN DECISIONS (documented per L6 spec):
 *
 * 1. Methods inside a named class: emitted as STANDALONE chunks (not
 *    nested children of the class chunk). Rationale: retrieval over
 *    `search_code("class Foo")` should return the full class chunk,
 *    but `search_code("Foo.bar implementation")` should be able to
 *    return just the method's span. SQLite has no tree structure;
 *    chunks are a flat table. Emitting both keeps retrieval
 *    granular without coupling to a parent/child schema.
 *
 * 2. Anonymous-class method handling: if a class has no `name` field
 *    (e.g. `const C = class { m() {} }`), the class itself is NOT
 *    emitted as a chunk and its methods are skipped from chunking —
 *    the top-level `lexical_declaration` for `C` covers that span
 *    already. This keeps the chunk set deduplicated.
 *
 * Constraints:
 *   - The Parser instance is NOT required in the public API. Callers
 *     pass a pre-parsed `tree`; we never call `parse()` ourselves.
 *   - We never mutate the input tree or its nodes.
 *   - We never log from this module — the caller decides what to surface.
 */

import type { SupportedLanguage } from './language-detect';
import { computeChunkId } from './chunk-id';

// Re-export so callers importing from `chunker` can get the language type
// without reaching into the L5-owned module. Keeps Wave 2 consumers
// decoupled from the exact file path.
export type { SupportedLanguage };

// Minimal structural types that mirror tree-sitter's API. Declared locally
// so this module type-checks even if the `tree-sitter` package isn't
// installed at build-time (L5 owns the grammar-loader and its dep). A real
// `Parser.Tree` from `tree-sitter` is structurally assignable to these.
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

export interface Chunk {
  /**
   * `computeChunkId(filePath, lineStart, lineEnd, symbolKind, symbolName)`
   * — stable across ingests. `symbolKind` and `symbolName` disambiguate
   * chunks whose spans coincide (e.g. a single-line class and its method).
   */
  chunkId: string;
  filePath: string;
  /** 1-indexed start line (inclusive). */
  lineStart: number;
  /** 1-indexed end line (inclusive). */
  lineEnd: number;
  content: string;
  language: SupportedLanguage;
  /**
   * If this chunk corresponds to a specific AST node, its high-level kind.
   * One of: 'class' | 'function' | 'method' | 'constructor' | 'interface' |
   * 'type' | 'file'. Omitted only for the whole-file fallback chunk.
   */
  symbolKind?: string;
  /** Identifier of the symbol, e.g. class name or method name. */
  symbolName?: string;
}

export interface ChunkFileInput {
  filePath: string;
  content: string;
  language: SupportedLanguage;
  tree: TSTree;
}

export function chunkFile(input: ChunkFileInput): Chunk[] {
  const { filePath, content, language, tree } = input;

  const chunks: Chunk[] = [];
  const seenSpans = new Set<string>();

  const emit = (
    node: TSNode,
    symbolKind: string | undefined,
    symbolName: string | undefined,
  ): void => {
    const lineStart = node.startPosition.row + 1;
    const lineEnd = node.endPosition.row + 1;
    const key = `${lineStart}:${lineEnd}:${symbolKind ?? ''}:${symbolName ?? ''}`;
    if (seenSpans.has(key)) return;
    seenSpans.add(key);

    const chunkContent = sliceByLines(content, lineStart, lineEnd);
    const chunkId = computeChunkId(
      filePath,
      lineStart,
      lineEnd,
      symbolKind,
      symbolName,
    );
    const chunk: Chunk = {
      chunkId,
      filePath,
      lineStart,
      lineEnd,
      content: chunkContent,
      language,
    };
    if (symbolKind !== undefined) chunk.symbolKind = symbolKind;
    if (symbolName !== undefined) chunk.symbolName = symbolName;
    chunks.push(chunk);
  };

  const rootNode = tree?.rootNode;

  if (rootNode && Array.isArray(rootNode.children)) {
    for (const child of rootNode.children) {
      walkForChunks(child, emit);
    }
  }

  // File-level fallback: always ensure the file has at least one chunk.
  if (chunks.length === 0) {
    const totalLines = countLines(content);
    const lineStart = 1;
    const lineEnd = Math.max(1, totalLines);
    const chunkId = computeChunkId(filePath, lineStart, lineEnd);
    chunks.push({
      chunkId,
      filePath,
      lineStart,
      lineEnd,
      content,
      language,
    });
  }

  return chunks;
}

/**
 * Walk a subtree looking for chunkable nodes. We descend into class bodies
 * (to emit methods) but we do NOT descend into function bodies (nested
 * functions are out of scope for Wave 2 — they can be a follow-up).
 */
function walkForChunks(
  node: TSNode,
  emit: (node: TSNode, symbolKind: string | undefined, symbolName: string | undefined) => void,
): void {
  const t = node.type;

  if (t === 'class_declaration') {
    const name = identifierName(node, 'name');
    if (!name) {
      // Anonymous/ERROR class at top level — skip (no identifier to key on).
      return;
    }
    emit(node, 'class', name);
    // Descend into the class body so each method also produces a chunk.
    const body = safeChildForField(node, 'body');
    if (body && Array.isArray(body.children)) {
      for (const bodyChild of body.children) {
        if (bodyChild.type === 'method_definition') {
          const methodName = methodPropertyName(bodyChild);
          if (!methodName) continue;
          const kind = methodName === 'constructor' ? 'constructor' : 'method';
          emit(bodyChild, kind, `${name}.${methodName}`);
        }
      }
    }
    return;
  }

  if (t === 'function_declaration' || t === 'generator_function_declaration') {
    const name = identifierName(node, 'name');
    if (!name) return;
    emit(node, 'function', name);
    return;
  }

  if (t === 'interface_declaration') {
    // TS-only node. JS grammar doesn't emit this; the TS grammar (not in
    // Wave 2's hard scope but tolerated) does. If the grammar didn't
    // produce an identifier child, skip.
    const name = identifierName(node, 'name');
    if (!name) return;
    emit(node, 'interface', name);
    return;
  }

  if (t === 'type_alias_declaration') {
    const name = identifierName(node, 'name');
    if (!name) return;
    emit(node, 'type', name);
    return;
  }

  if (t === 'lexical_declaration' || t === 'variable_declaration') {
    // `const foo = () => ...` / `const foo = function() {}` — emit one
    // chunk covering the full declaration for the FIRST declarator whose
    // initializer is an arrow or function expression.
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
      emit(node, 'function', nameNode.text);
      return;
    }
    return;
  }

  if (t === 'export_statement') {
    // `export class Foo {...}`, `export function foo(){}`, `export const f = () => {}`.
    // Descend one level — the inner declaration is what we want to chunk.
    for (const child of node.children || []) {
      walkForChunks(child, emit);
    }
    return;
  }

  // Anything else at top-level (imports, bare expressions, etc.) is not
  // chunked separately — it will be covered by the file-level fallback if
  // this is the only content in the file.
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
  const text = nameNode.text;
  if (!text) return null;
  return text;
}

function methodPropertyName(methodNode: TSNode): string | null {
  const nameNode = safeChildForField(methodNode, 'name');
  if (!nameNode) return null;
  // `name` can be property_identifier / private_property_identifier / string
  // / number / computed_property_name. We only handle the simple identifier
  // forms; everything else is skipped (covered by the class-level chunk).
  if (
    nameNode.type === 'property_identifier' ||
    nameNode.type === 'private_property_identifier'
  ) {
    return nameNode.text || null;
  }
  return null;
}

function sliceByLines(content: string, lineStart: number, lineEnd: number): string {
  const lines = content.split('\n');
  // Clamp: tree-sitter may report endPosition past the final newline on
  // files without a trailing \n; we clamp to the line array length.
  const startIdx = Math.max(0, lineStart - 1);
  const endIdx = Math.min(lines.length, lineEnd);
  return lines.slice(startIdx, endIdx).join('\n');
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split('\n').length;
}
