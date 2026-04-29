/**
 * Call-edge extraction for symbol-grain `find_dependencies` (0.5.0).
 *
 * Pre-0.5.0 the only edges we stored were file→file `imports`. Asking
 * `find_dependencies("AuthService.verify")` returned `[]` because there
 * was nowhere in the schema to record "call site". This module walks
 * each function/method body and emits one {@link ExtractedCall} per
 * call expression — the row that lands in `call_edges`.
 *
 * Scope (deliberately narrow for the MVP):
 *
 *   - SAME-FILE static calls only. Cross-file resolution (knowing that
 *     `findUser(...)` in `auth.ts` resolves to `db.ts::findUser`)
 *     requires walking imports + scope and is genuinely hard to do
 *     well; that lands in 0.6.x. Today we record the call site with
 *     the bare callee name; the agent can chain queries against the
 *     existing `imports` table when it needs cross-file edges.
 *
 *   - JS/TS only here. Python / Go / Java extractors mirror this
 *     module's shape and live alongside their existing symbol /
 *     import extractors so each language stays standalone.
 *
 *   - Two callee shapes recognised:
 *       1. `foo()`              → callee name = "foo",   qualified = null
 *       2. `obj.bar()`          → callee name = "bar",   qualified = "obj.bar"
 *     Anything else (`(x ?? y)()`, `arr[i]()`, dynamic
 *     `import(...)`) is skipped — those would emit too many false
 *     positives without a real type system.
 *
 *   - The enclosing function for `caller_qualified` is the nearest
 *     function/method/constructor ancestor. Calls outside any function
 *     (top-level expressions) are skipped — they're noise for the
 *     "who calls X" question.
 */

import { computeEdgeId, computeNodeId } from '../deterministic-ids';

// Minimal structural tree-sitter types — match the shapes used by
// chunker.ts / symbol-extractor.ts so this module type-checks without
// pulling in the `tree-sitter` `.d.ts`.
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
  childForFieldName?: (fieldName: string) => TSNode | null;
}

interface TSTree {
  rootNode: TSNode;
}

export interface ExtractedCall {
  /** Stable edge id derived from caller node + callee name + line. */
  edgeId: string;
  /** Deterministic node id of the enclosing function/method. */
  callerNodeId: string;
  /** Qualified name of the enclosing function/method (e.g. `Foo.bar`). */
  callerQualified: string;
  /** Simple identifier called (e.g. `verify` for `svc.verify(token)`). */
  calleeName: string;
  /** Best-effort dotted form (e.g. `svc.verify`). `null` for bare `foo()`. */
  calleeQualified: string | null;
  /** 1-indexed source line of the call expression. */
  callLine: number;
  /** AST-derived; we never infer here. */
  confidence: 'EXTRACTED';
}

export interface ExtractCallsInput {
  /** Repo-relative POSIX path, used to compute deterministic node ids. */
  filePath: string;
  /** Parsed tree-sitter tree. */
  tree: TSTree;
}

/**
 * Walk every function/method body in the tree and emit one
 * {@link ExtractedCall} per recognised call expression.
 *
 * Never throws on a malformed subtree — bad input → empty array +
 * `console.warn`, same policy as the symbol extractor.
 */
export function extractJsCalls(input: ExtractCallsInput): ExtractedCall[] {
  const out: ExtractedCall[] = [];
  try {
    const root = input.tree?.rootNode;
    if (!root || !Array.isArray(root.children)) return out;
    for (const child of root.children) {
      walk(child, /*enclosing*/ null, input.filePath, out);
    }
  } catch (err) {
    console.warn(
      `[call-extractor] JS/TS extraction failed for ${input.filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return out;
}

interface EnclosingFn {
  /** Qualified name of the enclosing function/method (e.g. `Foo.bar`). */
  qualified: string;
  /** Symbol kind — `'function' | 'method' | 'constructor'`. */
  kind: string;
}

function walk(
  node: TSNode,
  enclosing: EnclosingFn | null,
  filePath: string,
  out: ExtractedCall[],
): void {
  if (!node) return;
  const t = node.type;

  // Update the enclosing-function context when we descend into one.
  if (
    t === 'function_declaration' ||
    t === 'generator_function_declaration'
  ) {
    const name = identifierName(node, 'name');
    if (name) {
      const next: EnclosingFn = { qualified: name, kind: 'function' };
      walkChildren(node, next, filePath, out);
      return;
    }
  }

  if (t === 'class_declaration') {
    const className = identifierName(node, 'name');
    if (!className) {
      walkChildren(node, enclosing, filePath, out);
      return;
    }
    // Step into the class body and rebrand each method's enclosing
    // qualified name as `Class.method`.
    const body = safeChildForField(node, 'body');
    if (body && Array.isArray(body.children)) {
      for (const bodyChild of body.children) {
        if (bodyChild.type === 'method_definition') {
          const methodName = methodPropertyName(bodyChild);
          if (!methodName) continue;
          const kind =
            methodName === 'constructor' ? 'constructor' : 'method';
          const next: EnclosingFn = {
            qualified: `${className}.${methodName}`,
            kind,
          };
          walkChildren(bodyChild, next, filePath, out);
        } else {
          // Class fields, static blocks, etc. — keep walking under the
          // current enclosing context (likely null for top-level class).
          walk(bodyChild, enclosing, filePath, out);
        }
      }
    }
    return;
  }

  if (t === 'lexical_declaration' || t === 'variable_declaration') {
    // Mixed shapes: `const foo = () => {...}` (function-defining,
    // recurse with `foo` as the enclosing scope) AND `const u =
    // findUser(...)` (initializer is a call we still need to count
    // against the OUTER `enclosing`). Walk each declarator separately
    // and pick the right context for each.
    const declarators = (node.children || []).filter(
      (c) => c.type === 'variable_declarator',
    );
    for (const decl of declarators) {
      const nameNode = safeChildForField(decl, 'name');
      const valueNode = safeChildForField(decl, 'value');
      if (!valueNode) continue;
      const isFnValue =
        valueNode.type === 'arrow_function' ||
        valueNode.type === 'function_expression';
      if (
        isFnValue &&
        nameNode &&
        nameNode.type === 'identifier' &&
        nameNode.text
      ) {
        // `const foo = () => {...}` — descend with foo as enclosing.
        const next: EnclosingFn = { qualified: nameNode.text, kind: 'function' };
        walkChildren(valueNode, next, filePath, out);
      } else {
        // Plain initializer (`const u = findUser(...)`, destructuring,
        // etc.). Walk the value under the OUTER enclosing scope so
        // calls inside the initializer get attributed correctly.
        walk(valueNode, enclosing, filePath, out);
      }
    }
    return;
  }

  if (t === 'export_statement') {
    // Recurse into the inner declaration with the same enclosing context.
    walkChildren(node, enclosing, filePath, out);
    return;
  }

  // Call expression — emit only when we have an enclosing function.
  if (t === 'call_expression' && enclosing) {
    const fnNode = safeChildForField(node, 'function');
    const calleeShape = parseCalleeShape(fnNode);
    if (calleeShape) {
      const callLine = node.startPosition.row + 1;
      out.push(
        makeCall({
          filePath,
          enclosing,
          callee: calleeShape,
          callLine,
        }),
      );
    }
    // Don't descend into the callee subtree (avoid double-counting
    // chained calls like `a().b()` — we'll catch the inner via the
    // outer call's `arguments` instead).
    const args = safeChildForField(node, 'arguments');
    if (args) walk(args, enclosing, filePath, out);
    return;
  }

  walkChildren(node, enclosing, filePath, out);
}

function walkChildren(
  node: TSNode,
  enclosing: EnclosingFn | null,
  filePath: string,
  out: ExtractedCall[],
): void {
  for (const c of node.children || []) {
    walk(c, enclosing, filePath, out);
  }
}

interface CalleeShape {
  /** Simple identifier (e.g. `verify`). */
  name: string;
  /** Dotted form when the call is `a.b()` / `a.b.c()`; `null` for bare. */
  qualified: string | null;
}

/**
 * Given the `function` field of a `call_expression`, return the simple
 * + qualified name when the shape is one we recognise, else `null`.
 *
 *   identifier             → bare         { name, qualified: null }
 *   member_expression      → method       { name: prop, qualified: "obj.prop" }
 *   anything else          → null
 */
function parseCalleeShape(fnNode: TSNode | null): CalleeShape | null {
  if (!fnNode) return null;
  if (fnNode.type === 'identifier') {
    const name = fnNode.text;
    if (!name) return null;
    return { name, qualified: null };
  }
  if (fnNode.type === 'member_expression') {
    const propNode = safeChildForField(fnNode, 'property');
    const objNode = safeChildForField(fnNode, 'object');
    if (
      !propNode ||
      (propNode.type !== 'property_identifier' &&
        propNode.type !== 'private_property_identifier')
    ) {
      return null;
    }
    const propName = propNode.text;
    if (!propName) return null;
    // Stringify the receiver compactly. For `a.b.c`, walk recursively;
    // for unsupported receivers (`(x ?? y).foo()`), fall back to the
    // raw text — it's only used as a denorm hint, not a join key.
    const objText = objNode ? objNode.text : '';
    const qualified =
      objText && /^[A-Za-z_$][\w$.]*$/.test(objText)
        ? `${objText}.${propName}`
        : null;
    return { name: propName, qualified };
  }
  return null;
}

function makeCall(args: {
  filePath: string;
  enclosing: EnclosingFn;
  callee: CalleeShape;
  callLine: number;
}): ExtractedCall {
  const callerNodeId = computeNodeId(
    args.filePath,
    args.enclosing.kind,
    args.enclosing.qualified,
  );
  // Use the line as a discriminator so two calls to the same name
  // from the same caller (e.g. retry loops) get distinct edge ids.
  const calleeKey =
    args.callee.qualified ?? `bare:${args.callee.name}`;
  const calleeNodeId = computeNodeId(
    args.filePath,
    'call-site',
    `${calleeKey}@L${args.callLine}`,
  );
  return {
    edgeId: computeEdgeId(callerNodeId, calleeNodeId, 'CALLS'),
    callerNodeId,
    callerQualified: args.enclosing.qualified,
    calleeName: args.callee.name,
    calleeQualified: args.callee.qualified,
    callLine: args.callLine,
    confidence: 'EXTRACTED',
  };
}

// ─── Shared helpers (local copies — keep this module standalone) ─────────

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
