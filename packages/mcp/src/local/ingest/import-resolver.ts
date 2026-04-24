/**
 * Phase 11 Wave 2 — L8: Import path resolver.
 *
 * Pure path-resolution logic — no tree-sitter, no AST. Mirrors the subset of
 * Node's module-resolution algorithm that is relevant for the `imports`
 * table's `target_path` column:
 *
 *   - Relative specifiers (`./x`, `../y`) resolve against `srcFile`'s dir,
 *     with candidate extensions tried in priority order and `<spec>/index.*`
 *     as a fallback.
 *   - Absolute specifiers (`/abs/path`) are returned verbatim.
 *   - Everything else is treated as a bare specifier (npm package or Node
 *     built-in) and passed through with `resolvedPath: undefined`.
 *
 * Return contract: when an in-repo path resolves, `resolvedPath` is
 * **repo-relative** (forward-slash separated). Out-of-repo and absolute
 * specifiers keep their absolute form. Unresolved relatives fall back to
 * the resolved-but-extensionless path — the caller (L14 `find_dependencies`
 * in Wave 3) can still index this and use a `LIKE` match; losing the edge
 * entirely is strictly worse than emitting a close-enough key.
 *
 * TODO(phase11-wave4): support `compilerOptions.paths` from tsconfig.json.
 * v1 intentionally does not read tsconfig — see Wave 4 L20.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ResolvedImport {
  /**
   * - `relative` — `./x` / `../y`; `resolvedPath` is set.
   * - `absolute` — starts with `/`; `resolvedPath` is the unchanged abs path.
   * - `bare`     — npm package or Node built-in; `resolvedPath` is undefined.
   */
  kind: 'relative' | 'absolute' | 'bare';
  /** The original import specifier as written by the author. */
  raw: string;
  /**
   * Repo-relative POSIX-style path when the resolved file is inside the
   * repo root; absolute path otherwise. `undefined` for bare specifiers.
   */
  resolvedPath?: string;
}

/**
 * Extensions tried when the author wrote `./foo` without one. Order matters:
 * TS before JS because TS projects overwhelmingly prefer the `.ts` source
 * file over a generated `.js` sibling; `.tsx` before `.ts` to handle component
 * files where both may coexist; `.mts`/`.cts` for ESM/CJS-specific sources.
 */
const CANDIDATE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
];

/**
 * Candidate `index.*` entrypoints when `./foo` is a directory.
 */
const INDEX_CANDIDATES: readonly string[] = CANDIDATE_EXTENSIONS.map((ext) => `index${ext}`);

/**
 * Normalise an absolute filesystem path for the `target_path` column:
 *   - if it lives inside `repoRoot`, return the repo-relative POSIX path
 *   - otherwise return it as-is (absolute, OS-native separator kept)
 *
 * The POSIX-forward-slash convention matches what the walker emits for
 * `srcFile` and what the imports-target lookup query expects in Wave 3.
 */
function toRepoRelativeOrAbsolute(absolutePath: string, repoRoot: string): string {
  const normalisedRoot = path.resolve(repoRoot);
  const normalisedTarget = path.resolve(absolutePath);

  const rel = path.relative(normalisedRoot, normalisedTarget);
  // `path.relative` returns a path with `..` when the target escapes root;
  // detect that and fall back to the absolute form. Also guard against
  // same-path-as-root (`rel === ''`) which is a degenerate but legal case.
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return normalisedTarget;
  }
  // Normalise separators to forward slashes so this column is portable
  // across macOS/Linux/Windows corpora ingested into the same DB.
  return rel.split(path.sep).join('/');
}

/**
 * Try `candidate` as-is, then `candidate + ext` for each candidate extension,
 * then `candidate/index.*`. Returns the first absolute path that exists on
 * disk, or `null` if nothing matches.
 */
function probeFilesystem(candidate: string): string | null {
  // 1) exact path — caller already wrote an extension like `./foo.ts`.
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  // 2) extension-less: try each candidate extension.
  for (const ext of CANDIDATE_EXTENSIONS) {
    const withExt = candidate + ext;
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
      return withExt;
    }
  }

  // 3) directory: try `<candidate>/index.<ext>`.
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    for (const indexFile of INDEX_CANDIDATES) {
      const joined = path.join(candidate, indexFile);
      if (fs.existsSync(joined) && fs.statSync(joined).isFile()) {
        return joined;
      }
    }
  }

  return null;
}

/**
 * Resolve an import specifier to a `ResolvedImport`.
 *
 * @param specifier            The literal string inside `from '...'` — must
 *                             already have surrounding quotes stripped.
 * @param srcFileAbsolutePath  Absolute path of the file containing the
 *                             import. Used as the base for relative resolution.
 * @param repoRoot             Absolute path of the repo root, used to
 *                             produce repo-relative `resolvedPath` values.
 */
export function resolveImport(
  specifier: string,
  srcFileAbsolutePath: string,
  repoRoot: string,
): ResolvedImport {
  // Bare / built-in specifier fast path. Order matters: check relative /
  // absolute markers first because `./foo` would otherwise look "bare-ish".
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const srcDir = path.dirname(srcFileAbsolutePath);
    const candidateAbs = path.resolve(srcDir, specifier);
    const probed = probeFilesystem(candidateAbs);

    if (probed) {
      return {
        kind: 'relative',
        raw: specifier,
        resolvedPath: toRepoRelativeOrAbsolute(probed, repoRoot),
      };
    }

    // Unresolved fallback: keep the caller-visible path without extension.
    // Rationale: we still want to emit an edge so Wave 3's
    // `find_dependencies` query can `LIKE` / exact-match against files that
    // are later created, or against a partial-index of siblings. Losing the
    // edge because `./foo` has no extension on disk (yet) is worse than
    // storing the extensionless stub.
    return {
      kind: 'relative',
      raw: specifier,
      resolvedPath: toRepoRelativeOrAbsolute(candidateAbs, repoRoot),
    };
  }

  if (specifier.startsWith('/')) {
    // Absolute paths are untouched. We do not probe the filesystem here —
    // absolute paths in JS/TS source are exceedingly rare and a probe would
    // surprise the caller (e.g. collapsing a symlink).
    return {
      kind: 'absolute',
      raw: specifier,
      resolvedPath: specifier,
    };
  }

  // Bare — npm package (including `@scope/pkg` and subpaths like
  // `lodash/fp`) or Node built-in like `fs` / `node:fs`.
  return {
    kind: 'bare',
    raw: specifier,
    resolvedPath: undefined,
  };
}
