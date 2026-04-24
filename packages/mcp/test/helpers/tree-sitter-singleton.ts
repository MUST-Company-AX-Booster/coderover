/**
 * Shared tree-sitter helper for spec files.
 *
 * Delegates to the production grammar-loader. Also gates real-parse
 * suites behind an env flag because tree-sitter's node binding has a
 * known cross-spec invalidation issue (https://github.com/tree-sitter/
 * node-tree-sitter) that flakes when many specs share one jest worker.
 *
 * Set `TS_REAL=1` to run the real-parse suites. Default jest invocation
 * skips them; `npm run test:ts` runs each tree-sitter spec in its own
 * jest process which sidesteps the flake.
 */

import { parseFile } from '../../src/local/ingest/grammar-loader';

export function parseSharedJs(src: string): any {
  return parseFile(src, 'javascript');
}

let available: boolean | null = null;
export function treeSitterAvailable(): boolean {
  if (process.env.TS_REAL !== '1') return false;
  if (available !== null) return available;
  try {
    parseFile('', 'javascript');
    available = true;
  } catch {
    available = false;
  }
  return available;
}
