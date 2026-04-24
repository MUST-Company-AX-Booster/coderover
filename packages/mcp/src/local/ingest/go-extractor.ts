/**
 * Phase 11 Wave 4 — L20: Go symbol + import extractor.
 *
 * Mirrors the JS/Python extractor shape: two exported functions,
 * `ExtractedSymbol[]` / `ExtractedImport[]` shared with Wave 2.
 *
 * ### Node-type cheat sheet (tree-sitter-go)
 *
 *   function_declaration    ← `func Foo() { ... }`
 *     fields: name, parameters, result?, body
 *   method_declaration      ← `func (r *Repo) Save() {...}`
 *     fields: receiver, name, parameters, result?, body
 *     receiver child: `parameter_list` containing a `parameter_declaration`
 *       whose `type` is a `pointer_type` / `type_identifier` / `generic_type`.
 *   type_declaration        ← `type X struct {}` / `type Y int` / `type Z interface {}`
 *     children: type_spec (one per contiguous group in `type ( ... )`)
 *   type_spec               ← single binding inside a type_declaration
 *     fields: name, type
 *     type can be: struct_type, interface_type, type_identifier, pointer_type,
 *                  array_type, slice_type, map_type, function_type, ...
 *   import_declaration      ← `import "x"` or `import ( "x" "y" )`
 *     children: import_spec / import_spec_list
 *   import_spec             ← a single import line
 *     fields: name? (the alias / dot / underscore), path
 *     path child type: interpreted_string_literal (quotes included in `.text`)
 *
 * ### Design notes
 *
 *   - Method receiver may be `(r Repo)` (value) or `(r *Repo)` (pointer).
 *     Backend reference strips leading `*`/`&` and generics `<...>`. We do
 *     the same via `extractReceiverType`.
 *   - Non-standalone method receiver parses as a `parameter_list` with
 *     exactly one `parameter_declaration`. The type child is either a
 *     `type_identifier`, a `pointer_type` (which itself wraps a type), or
 *     a `generic_type`.
 *   - `type X struct { ... }` → kind `'struct'`; `type Y int` → `'type'`;
 *     `type Z interface { ... }` → `'interface'`. Everything else (aliases
 *     to slice_type, map_type, etc.) gets kind `'type'`.
 *   - Imports use Go's `pkg:` convention even for paths that look like
 *     URLs (e.g. `github.com/foo/bar`). Go modules don't resolve to local
 *     files — we always emit them as `bare`.
 *   - `import _ "x"` / `import . "x"` / `import alias "x"` all reduce to
 *     the same bare import — the alias/blank/dot is irrelevant to the edge.
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

export interface ExtractGoImportsInput {
  filePath: string;
  absolutePath: string;
  repoRoot: string;
  tree: TSTree;
}

/**
 * Emit symbols for every named function, method, struct, interface, and
 * type alias at the top level. Go does not support top-level nesting, so
 * we walk only direct children of the root `source_file`.
 */
export function extractGoSymbols(input: ExtractSymbolsInput): ExtractedSymbol[] {
  const { filePath, chunks, tree } = input;
  const symbols: ExtractedSymbol[] = [];
  try {
    const rootNode = tree?.rootNode;
    if (!rootNode || !Array.isArray(rootNode.children)) return symbols;

    for (const child of rootNode.children) {
      handleTopLevel(child, symbols, filePath, chunks);
    }
  } catch (err) {
    console.warn(
      `[go-extractor] symbol extraction failed for ${input.filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return symbols;
}

function handleTopLevel(
  node: TSNode,
  out: ExtractedSymbol[],
  filePath: string,
  chunks: ExtractSymbolsInput['chunks'],
): void {
  if (node.type === 'function_declaration') {
    const name = identifierName(node, 'name');
    if (!name) return;
    pushSymbol(out, filePath, chunks, node, 'function', name, name);
    return;
  }

  if (node.type === 'method_declaration') {
    const name = identifierName(node, 'name');
    if (!name) return;
    const receiverType = extractReceiverType(node);
    const qualified = receiverType ? `${receiverType}.${name}` : name;
    pushSymbol(out, filePath, chunks, node, 'method', name, qualified);
    return;
  }

  if (node.type === 'type_declaration') {
    // `type X struct {}` or `type ( X struct{}; Y int )`. Emit one symbol
    // per type_spec child.
    for (const c of node.children || []) {
      if (c.type !== 'type_spec') continue;
      const name = identifierName(c, 'name');
      if (!name) continue;
      const kind = classifyTypeSpec(c);
      pushSymbol(out, filePath, chunks, c, kind, name, name);
    }
    return;
  }
}

/**
 * Classify a `type_spec` as 'struct', 'interface', or 'type'. Backend uses
 * the same three buckets; see the header comment for mapping.
 */
function classifyTypeSpec(typeSpec: TSNode): string {
  const typeChild = safeChildForField(typeSpec, 'type');
  if (!typeChild) return 'type';
  switch (typeChild.type) {
    case 'struct_type':
      return 'struct';
    case 'interface_type':
      return 'interface';
    default:
      // type_identifier, pointer_type, array_type, slice_type, map_type,
      // function_type, generic_type, ... — all collapse to 'type'.
      return 'type';
  }
}

/**
 * Pull the receiver type out of a `method_declaration`. The receiver node
 * is a `parameter_list` (the `(r *Repo)` in `func (r *Repo) Save() {}`)
 * with one `parameter_declaration` child whose type field is either a
 * `type_identifier` (`Repo`), a `pointer_type` wrapping a type_identifier
 * (`*Repo`), or a `generic_type` (`Repo[T]`). We strip leading `*` and
 * any generic `[...]` suffix so the result matches what the struct was
 * declared as.
 */
function extractReceiverType(methodNode: TSNode): string {
  const receiver = safeChildForField(methodNode, 'receiver');
  if (!receiver) return '';

  // Receiver is a parameter_list; walk to the single parameter_declaration.
  let paramDecl: TSNode | null = null;
  for (const c of receiver.children || []) {
    if (c.type === 'parameter_declaration') {
      paramDecl = c;
      break;
    }
  }
  if (!paramDecl) return '';

  const typeNode = safeChildForField(paramDecl, 'type');
  if (!typeNode) return '';

  return normaliseTypeName(typeNode);
}

/**
 * Walk into a type node and return its "bare" name:
 *   type_identifier         → its text
 *   pointer_type            → normalise on its inner type
 *   generic_type            → normalise on its type child; strip `[...]`
 *   qualified_type          → right-most identifier
 *   anything else           → text, fallback
 */
function normaliseTypeName(node: TSNode): string {
  if (node.type === 'type_identifier') {
    return (node.text || '').trim();
  }
  if (node.type === 'pointer_type') {
    // Pointer type has a single child = the underlying type. Field is usually
    // named `type`, but fall back to the first named child.
    const inner = safeChildForField(node, 'type') ?? firstNamedChild(node);
    if (inner) return normaliseTypeName(inner);
    return stripPrefixes(node.text || '');
  }
  if (node.type === 'generic_type') {
    const inner = safeChildForField(node, 'type') ?? firstNamedChild(node);
    if (inner) return normaliseTypeName(inner);
    // Defensive: `Foo[T]` text → `Foo`.
    const text = (node.text || '').trim();
    const idx = text.indexOf('[');
    return idx >= 0 ? text.slice(0, idx).trim() : text;
  }
  if (node.type === 'qualified_type') {
    // `pkg.Type` — receivers can't actually be qualified in Go (must be a
    // named type in the same package) but handle it defensively.
    const right = safeChildForField(node, 'name');
    if (right) return (right.text || '').trim();
  }
  // Fallback — strip pointer/ref markers and generic brackets.
  return stripPrefixes(node.text || '');
}

function stripPrefixes(text: string): string {
  let s = text.trim();
  while (s.startsWith('*') || s.startsWith('&')) s = s.slice(1).trim();
  const idx = s.indexOf('[');
  if (idx >= 0) s = s.slice(0, idx).trim();
  // Handle qualified `pkg.Name` fallback.
  const lastDot = s.lastIndexOf('.');
  if (lastDot >= 0) s = s.slice(lastDot + 1);
  return s;
}

/**
 * Walk the tree and emit one bare import per distinct Go import path.
 * `import ( "a"; "b" )` → two imports; `import "x"` → one.
 */
export function extractGoImports(input: ExtractGoImportsInput): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  const seen = new Set<string>();
  try {
    const rootNode = input.tree?.rootNode;
    if (!rootNode) return out;

    const visit = (node: TSNode | null | undefined): void => {
      if (!node) return;
      if (node.type === 'import_declaration') {
        for (const c of node.children || []) {
          if (c.type === 'import_spec') {
            handleImportSpec(c, out, seen, input);
          } else if (c.type === 'import_spec_list') {
            for (const spec of c.children || []) {
              if (spec.type === 'import_spec') {
                handleImportSpec(spec, out, seen, input);
              }
            }
          }
        }
        return;
      }
      for (const c of node.children || []) visit(c);
    };

    visit(rootNode);
  } catch (err) {
    console.warn(
      `[go-extractor] import extraction failed for ${input.filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return out;
}

function handleImportSpec(
  spec: TSNode,
  out: ExtractedImport[],
  seen: Set<string>,
  input: ExtractGoImportsInput,
): void {
  const pathNode = safeChildForField(spec, 'path');
  const pathLiteral = pathNode && pathNode.type === 'interpreted_string_literal'
    ? pathNode
    : firstChildOfType(spec, 'interpreted_string_literal');
  if (!pathLiteral) return;
  const pkg = stripQuotes(pathLiteral.text);
  if (!pkg) return;

  const targetPath = `pkg:${pkg}`;
  if (seen.has(targetPath)) return;
  seen.add(targetPath);

  const srcNodeId = computeNodeId(input.filePath, 'file', input.filePath);
  const dstNodeId = computeNodeId(targetPath, 'file', targetPath);
  out.push({
    edgeId: computeEdgeId(srcNodeId, dstNodeId, 'IMPORTS'),
    srcFile: input.filePath,
    targetPath,
    specifier: pkg,
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

function firstNamedChild(node: TSNode): TSNode | null {
  const named = node.namedChildren;
  if (named && named.length > 0) return named[0];
  for (const c of node.children || []) {
    // Cheap named-child approximation: anything not wrapped in obvious
    // punctuation is "named enough" for our purposes.
    if (c.type && c.type !== '*' && c.type !== '&') return c;
  }
  return null;
}

function firstChildOfType(node: TSNode, type: string): TSNode | null {
  for (const c of node.children || []) {
    if (c.type === type) return c;
  }
  return null;
}

function identifierName(node: TSNode, field: string): string | null {
  const nameNode = safeChildForField(node, field);
  if (!nameNode) return null;
  const text = nameNode.text;
  return text || null;
}

function stripQuotes(raw: string | undefined): string | null {
  if (!raw) return null;
  if (raw.length < 2) return null;
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === '"' || first === '`' || first === "'") && first === last) {
    return raw.slice(1, -1);
  }
  return raw;
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
