/**
 * Phase 11 Wave 2 — L8: JS/TS import extractor.
 *
 * Walks a tree-sitter AST and emits one `ExtractedImport` per distinct
 * import edge. The extractor owns:
 *
 *   1. Which AST node shapes count as imports (see `handleNode`).
 *   2. Edge-ID computation — stable and reversible via
 *      `computeNodeId`/`computeEdgeId` so L14's `find_dependencies` in
 *      Wave 3 can round-trip from a source file to all its targets.
 *   3. De-duplication of the same `(srcFile, targetPath)` pair so a file
 *      that imports the same module three times (e.g. a re-export plus a
 *      runtime import plus a `require`) only produces one edge.
 *
 * Typing strategy: we deliberately DO NOT `import type Parser from
 * 'tree-sitter'` here. The `tree-sitter` dep is wired by a separate agent
 * (see `package.json` TODO) and the local tsconfig should compile this
 * module without it. Instead, we declare the narrow node shape we need
 * below and require callers to pass us the `Parser.Tree` as `unknown` /
 * the structural type. This keeps us decoupled from grammar versions too.
 *
 * Scope: JS/TS only. Python/Go/Java land in Wave 4 (L20) and will live in
 * parallel files so we don't balloon this one.
 */

import { computeEdgeId, computeNodeId } from '../deterministic-ids';
import { resolveImport, type ResolvedImport } from './import-resolver';
import type { SupportedLanguage } from './language-detect';

/**
 * Narrow structural type for the subset of tree-sitter nodes we touch.
 * Matches the real `Parser.SyntaxNode` shape but decouples us from the
 * type package. Every field we read is optional because tree-sitter's
 * N-API surface omits fields on degenerate nodes (error recovery, empty
 * files, etc.).
 */
interface TSNode {
  type: string;
  text?: string;
  startIndex?: number;
  endIndex?: number;
  childCount?: number;
  namedChildCount?: number;
  child?: (i: number) => TSNode | null;
  namedChild?: (i: number) => TSNode | null;
  childForFieldName?: (name: string) => TSNode | null;
  children?: ReadonlyArray<TSNode>;
}

/**
 * Narrow structural type for `Parser.Tree`. Only `rootNode` is required.
 */
interface TSTree {
  rootNode: TSNode;
}

export interface ExtractedImport {
  /** Deterministic edge ID; stable across runs for identical inputs. */
  edgeId: string;
  /** Repo-relative POSIX path of the importing file. */
  srcFile: string;
  /**
   * Target identifier suitable for the `imports.target_path` column:
   *   - repo-relative POSIX path for in-repo resolved files
   *   - repo-relative stub (no extension) for unresolved relative imports
   *     (so Wave 3 can still index them; see import-resolver docstring)
   *   - absolute path for `/...` absolute specifiers
   *   - `pkg:<specifier>` for bare (npm / Node built-in) imports
   */
  targetPath: string;
  /** The original import specifier as written by the author. */
  specifier: string;
  kind: 'relative' | 'absolute' | 'bare';
  /** v1 only emits AST-derived edges; hard-coded for clarity. */
  confidence: 'EXTRACTED';
}

export interface ExtractImportsInput {
  /** Repo-relative POSIX path of the source file. */
  filePath: string;
  /** Absolute filesystem path; required for relative-import resolution. */
  absolutePath: string;
  /** Absolute path of the repo root. */
  repoRoot: string;
  /**
   * Parsed tree from tree-sitter. Typed loosely so callers don't have to
   * import `Parser.Tree` through a re-export — any object with `rootNode`
   * works.
   */
  tree: TSTree;
  /** Language for the source file — used for future grammar-specific logic. */
  language: SupportedLanguage;
}

/**
 * Extract every distinct import edge from `input.tree`.
 *
 * Recognised forms (JS/TS):
 *
 *   import x from './y'
 *   import { x } from './y'
 *   import './y'                  (side-effect)
 *   import * as ns from './y'
 *   export { x } from './y'       (re-export, treated as a dep)
 *   export * from './y'
 *   const x = require('./y')      (CommonJS)
 *   await import('./y')           (dynamic)
 *
 * Skipped (uncommon in modern JS/TS):
 *   import x = require('./y')     (TS namespace import — Wave 4)
 *
 * De-duplication is keyed by `(srcFile, targetPath)`. The first occurrence
 * wins.
 */
export function extractImports(input: ExtractImportsInput): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  const seenTargets = new Set<string>();

  const visit = (node: TSNode | null | undefined): void => {
    if (!node) return;

    const specifier = specifierForNode(node);
    if (specifier !== null) {
      const resolved = resolveImport(specifier, input.absolutePath, input.repoRoot);
      const targetPath = computeTargetPath(resolved);

      if (!seenTargets.has(targetPath)) {
        seenTargets.add(targetPath);

        // Stable file-level node IDs. The pair `(filePath, 'file', filePath)`
        // mirrors what Wave 3 uses when it loads imports out of the DB to
        // satisfy `find_dependencies` — the identity column is the file
        // path both times, matching the "file IS its own qualified name"
        // convention used elsewhere in the codebase.
        const srcNodeId = computeNodeId(input.filePath, 'file', input.filePath);
        const dstNodeId = computeNodeId(targetPath, 'file', targetPath);

        out.push({
          edgeId: computeEdgeId(srcNodeId, dstNodeId, 'IMPORTS'),
          srcFile: input.filePath,
          targetPath,
          specifier,
          kind: resolved.kind,
          confidence: 'EXTRACTED',
        });
      }
    }

    // Recurse — we walk the whole tree so nested imports (e.g. dynamic
    // `import()` inside a function body, `require()` in a conditional)
    // are found. Tree-sitter's `childCount` includes unnamed punctuation
    // nodes which we simply skip via the `specifierForNode` filter.
    const count = node.childCount ?? (node.children?.length ?? 0);
    for (let i = 0; i < count; i++) {
      const child = node.child ? node.child(i) : node.children?.[i] ?? null;
      visit(child);
    }
  };

  visit(input.tree.rootNode);
  return out;
}

/**
 * If `node` is an import/require form we care about, return the raw
 * specifier (with quotes stripped). Returns `null` for everything else.
 *
 * All of these handlers are intentionally defensive: they return `null`
 * rather than throwing on malformed inputs because tree-sitter is
 * error-tolerant and will hand us broken nodes inside files that have
 * partial syntax errors.
 */
function specifierForNode(node: TSNode): string | null {
  switch (node.type) {
    case 'import_statement': {
      // Grammar: `import ... from 'spec'` or `import 'spec'` (side-effect).
      // Both shapes expose the string literal at field `source`.
      const source = node.childForFieldName?.('source');
      return stripQuotes(source?.text);
    }

    case 'export_statement': {
      // `export { x } from 'spec'` and `export * from 'spec'` both expose
      // the string literal at field `source` in tree-sitter-javascript. A
      // plain `export const x = ...` has no `source` child and returns
      // null, which is exactly what we want (we only care about
      // re-exports, which carry a cross-file dep).
      const source = node.childForFieldName?.('source');
      if (!source) return null;
      return stripQuotes(source.text);
    }

    case 'call_expression': {
      // Either `require('spec')` or `import('spec')`.
      // The function identifier is at field `function`; args at `arguments`.
      const fn = node.childForFieldName?.('function');
      const fnText = fn?.text;
      const args = node.childForFieldName?.('arguments');
      if (!args) return null;

      if (fnText === 'require') {
        // CommonJS.
        return firstStringLiteralArg(args);
      }
      // Dynamic import(): the `function` slot is the `import` keyword node
      // whose type is literally `import`. Its `text` is also `"import"`
      // but we key off the node type for robustness.
      if (fn?.type === 'import' || fnText === 'import') {
        return firstStringLiteralArg(args);
      }
      return null;
    }

    default:
      return null;
  }
}

/**
 * Given a tree-sitter `arguments` node, return the string content of its
 * first string-literal child, or `null` if the first argument is not a
 * plain string literal (e.g. a template literal, a variable).
 *
 * Template-literal imports (`require(`./${x}`)`) are intentionally not
 * resolved here — they are dynamic by nature and would produce noisy,
 * low-confidence edges.
 */
function firstStringLiteralArg(argsNode: TSNode): string | null {
  const count = argsNode.namedChildCount ?? argsNode.childCount ?? 0;
  for (let i = 0; i < count; i++) {
    const child = argsNode.namedChild
      ? argsNode.namedChild(i)
      : argsNode.child
        ? argsNode.child(i)
        : null;
    if (!child) continue;
    if (child.type === 'string') {
      return stripQuotes(child.text);
    }
    // First non-punctuation, non-string child decides — if it's not a
    // string we bail.
    return null;
  }
  return null;
}

/**
 * Strip surrounding single or double quotes from a string-literal's text.
 * Tree-sitter emits the literal including its quote characters.
 */
function stripQuotes(raw: string | undefined): string | null {
  if (!raw) return null;
  if (raw.length < 2) return null;
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === '"' || first === "'" || first === '`') && first === last) {
    return raw.slice(1, -1);
  }
  // Defensive: if somehow the quotes were already stripped, accept it.
  return raw;
}

/**
 * Map a `ResolvedImport` to the value we store in `imports.target_path`.
 * See `ExtractedImport.targetPath` for the mapping table.
 */
function computeTargetPath(resolved: ResolvedImport): string {
  switch (resolved.kind) {
    case 'relative':
      // `resolvedPath` is always set by the resolver for relative imports
      // (either to a real file or to the extensionless fallback).
      return resolved.resolvedPath ?? resolved.raw;
    case 'absolute':
      return resolved.resolvedPath ?? resolved.raw;
    case 'bare':
      // `pkg:` prefix so downstream queries can cheaply distinguish
      // in-repo paths from npm-package specifiers with a LIKE check.
      return `pkg:${resolved.raw}`;
  }
}
