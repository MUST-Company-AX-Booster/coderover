/**
 * Phase 11 Wave 2 — L5: tree-sitter grammar loader.
 * Phase 11 Wave 4 — L20: added Python, Go, and Java grammars.
 * 0.5.0 — added optional `tree-sitter-typescript` via the
 * `@coderover/mcp-typescript` companion package (B3).
 *
 * Each grammar is cached on first access. The cache key is the language
 * enum, so adding more languages is a one-case edit to the switch below.
 *
 * ### TypeScript dispatch
 *
 * Through 0.4.x, `.ts` / `.tsx` files used `tree-sitter-javascript` —
 * which parses many TS files but degrades on type annotations,
 * interfaces, type aliases, generics, and decorators (everything ends
 * up under `hasError` nodes, so the chunker drops the affected
 * declarations). 0.5.0 introduces a graceful upgrade path: if
 * `tree-sitter-typescript` is on the resolution path (typically via
 * the `@coderover/mcp-typescript` companion package) we use the real
 * TS grammar; otherwise we fall back to the JS grammar with a
 * one-line stderr warning so the user knows the upgrade is available.
 * The probe runs once per process and the result is cached.
 *
 * ### Singleton Parser per language
 *
 * tree-sitter's native binding has process-wide mutable state. Creating
 * a second Parser in the same Node process while an earlier one still
 * holds a Tree corrupts the earlier Tree (rootNode becomes undefined)
 * and makes suites that share a jest worker flake. The fix: one Parser
 * per language, shared across every caller in the process. Ingest is
 * single-threaded (one file at a time) so the sharing is safe in
 * production too.
 *
 * We use `require()` synchronously so tests can import the Parser
 * directly without bridging an async call. Dynamic `import()` of a
 * native CJS package offers no advantage here and complicates the
 * singleton cache.
 */

import Parser from 'tree-sitter';
import type { SupportedLanguage } from './language-detect';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const grammarCache = new Map<SupportedLanguage, any>();

/**
 * Test seam for the `require('tree-sitter-typescript')` probe. Lets
 * specs simulate "companion installed" / "companion missing" without
 * mutating `node_modules`. Production code leaves this undefined and
 * we go through the real `require`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let typescriptRequireOverride: ((id: string) => any) | undefined;

/** Has the TS grammar resolution probe already run this process? */
let typescriptProbeDone = false;
/** Cached probe result — `true` when the companion is resolvable. */
let typescriptCompanionAvailable = false;

/**
 * Test-only: inject a custom `require()` for the TS grammar probe.
 * Pass `undefined` to clear and use the real `require`. Also resets
 * the probe so the next `loadGrammar('typescript')` re-runs it.
 */
export function __setTypeScriptRequireForTests(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: ((id: string) => any) | undefined,
): void {
  typescriptRequireOverride = fn;
  typescriptProbeDone = false;
  typescriptCompanionAvailable = false;
  grammarCache.delete('typescript');
}

/**
 * Probe whether `tree-sitter-typescript` is installed (typically via
 * `@coderover/mcp-typescript`). Returns the grammar object on success
 * or `null` on resolution failure. The fallback warning fires once
 * per process so noisy reindexes don't spam stderr.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function probeTypeScriptGrammar(): any | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req = typescriptRequireOverride ?? require;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = req('tree-sitter-typescript');
    // tree-sitter-typescript exposes both dialects:
    //   require('tree-sitter-typescript').typescript   → .ts grammar
    //   require('tree-sitter-typescript').tsx          → .tsx grammar
    // We standardise on the typescript dialect for both .ts and .tsx —
    // the `typescript` grammar accepts JSX-light forms cleanly enough
    // for indexing, and a single grammar avoids a second cache slot.
    const grammar = mod?.typescript ?? mod?.default ?? mod;
    typescriptProbeDone = true;
    typescriptCompanionAvailable = true;
    return grammar;
  } catch {
    if (!typescriptProbeDone) {
      process.stderr.write(
        '[coderover-mcp] tree-sitter-typescript not installed; ' +
          'using JS-grammar fallback for .ts files. ' +
          'Install @coderover/mcp-typescript for full TS coverage ' +
          '(interface, type, generics, return annotations).\n',
      );
    }
    typescriptProbeDone = true;
    typescriptCompanionAvailable = false;
    return null;
  }
}

/**
 * Returns the cached probe result without re-running. Used by `doctor`
 * (and tests) to report whether the companion is wired in.
 */
export function isTypeScriptCompanionAvailable(): boolean {
  if (!typescriptProbeDone) probeTypeScriptGrammar();
  return typescriptCompanionAvailable;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadGrammar(lang: SupportedLanguage): any {
  if (grammarCache.has(lang)) return grammarCache.get(lang);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let grammar: any;
  switch (lang) {
    case 'typescript': {
      // 0.5.0: prefer the real TS grammar via the companion package;
      // fall back to JS grammar if the companion isn't installed.
      const tsGrammar = probeTypeScriptGrammar();
      if (tsGrammar) {
        grammar = tsGrammar;
        break;
      }
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
      const fallback: any = require('tree-sitter-javascript');
      grammar = fallback?.default ?? fallback;
      break;
    }
    case 'javascript': {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
      const mod: any = require('tree-sitter-javascript');
      grammar = mod?.default ?? mod;
      break;
    }
    case 'python': {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
      const mod: any = require('tree-sitter-python');
      grammar = mod?.default ?? mod;
      break;
    }
    case 'go': {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
      const mod: any = require('tree-sitter-go');
      grammar = mod?.default ?? mod;
      break;
    }
    case 'java': {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
      const mod: any = require('tree-sitter-java');
      grammar = mod?.default ?? mod;
      break;
    }
    default: {
      const _exhaustive: never = lang;
      throw new Error(`unsupported language: ${_exhaustive as string}`);
    }
  }

  grammarCache.set(lang, grammar);
  return grammar;
}

/**
 * Parse `content` using the grammar for `lang`. Allocates a fresh Parser
 * per call — reusing a Parser across calls in tree-sitter's Node binding
 * can invalidate previously-returned Trees. Fresh per call is the only
 * robust pattern. Allocation cost is negligible vs parsing cost.
 *
 * Returns a Tree whose `rootNode.hasError` is true for invalid input —
 * tree-sitter is error-tolerant.
 */
export function parseFile(content: string, lang: SupportedLanguage): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(loadGrammar(lang));
  return parser.parse(content);
}

/** Test-only: clear the grammar cache. */
export function __clearGrammarCacheForTests(): void {
  grammarCache.clear();
}
