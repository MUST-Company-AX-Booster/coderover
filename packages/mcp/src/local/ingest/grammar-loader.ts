/**
 * Phase 11 Wave 2 — L5: tree-sitter grammar loader.
 * Phase 11 Wave 4 — L20: added Python, Go, and Java grammars.
 *
 * Wave 2 scope: JS/TS only (same grammar `tree-sitter-javascript` for both;
 * Wave 4 would split TS out when it adds Python/Go/etc). Wave 4 keeps the
 * shared JS grammar for TS (full TS grammar is a future wave) and layers
 * Python/Go/Java alongside it via `tree-sitter-python` / `tree-sitter-go`
 * / `tree-sitter-java`. Each grammar is cached on first access the same
 * way — the cache key is the language enum, so adding more languages is
 * a one-case edit to the switch below.
 *
 * ### Singleton Parser per language
 *
 * tree-sitter's native binding has process-wide mutable state. Creating a
 * second Parser in the same Node process while an earlier one still holds
 * a Tree corrupts the earlier Tree (rootNode becomes undefined) and makes
 * suites that share a jest worker flake. The fix: one Parser per language,
 * shared across every caller in the process. Ingest is single-threaded
 * (one file at a time) so the sharing is safe in production too.
 *
 * We use `require()` synchronously so tests can import the Parser directly
 * without bridging an async call. Dynamic `import()` of a native CJS
 * package offers no advantage here and complicates the singleton cache.
 */

import Parser from 'tree-sitter';
import type { SupportedLanguage } from './language-detect';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const grammarCache = new Map<SupportedLanguage, any>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadGrammar(lang: SupportedLanguage): any {
  if (grammarCache.has(lang)) return grammarCache.get(lang);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let grammar: any;
  switch (lang) {
    case 'javascript':
    case 'typescript': {
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
