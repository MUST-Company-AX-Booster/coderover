/**
 * Phase 11 Wave 2 — L5: Language detection seam.
 * Phase 11 Wave 4 — L20: extended to Python, Go, and Java.
 *
 * Wave 2 shipped JS/TS only. Wave 4 adds Python/Go/Java by extending
 * `SupportedLanguage` and the `EXTENSION_MAP` below (purely additive — every
 * Wave 2 caller continues to resolve exactly the same way). Rust/Kotlin/PHP
 * stay deferred for a future wave to keep scope honest.
 *
 * Keep this module tiny — it is the single place ingest code asks "what
 * language is this file?" and the single place we declare which extensions
 * we will attempt to parse.
 *
 * Case handling: extension lookup is case-insensitive. Some macOS / Windows
 * repos contain `Foo.TS` or `.JSX` for historical reasons; refusing to index
 * them would be user-hostile for a feature-parity promise against remote
 * mode. Same policy extends to `.PY` / `.GO` / `.JAVA`.
 */

import * as path from 'path';

export type SupportedLanguage =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'go'
  | 'java';

const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  // JS/TS (Wave 2)
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  // Python (Wave 4). `.pyw` is the Windows-GUI variant; identical grammar.
  '.py': 'python',
  '.pyw': 'python',
  // Go (Wave 4).
  '.go': 'go',
  // Java (Wave 4).
  '.java': 'java',
};

/**
 * Returns the `SupportedLanguage` for the given file path, or `null` if the
 * extension is not one we index. The extension compare is case-insensitive.
 */
export function detectLanguage(filePath: string): SupportedLanguage | null {
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return null;
  return EXTENSION_MAP[ext] ?? null;
}

/**
 * All extensions we will attempt to index. Exposed for the walker so it can
 * cheaply filter files before reading them from disk.
 */
export const SUPPORTED_EXTENSIONS: readonly string[] = Object.keys(EXTENSION_MAP);
