/**
 * Phase 11 Wave 2 — L5: filesystem walker + parser for local-mode MCP.
 *
 * Given a repo root, streams `WalkedFile` records for every source file we
 * can index. Streaming (async generator) keeps memory flat on 100k-file
 * repos: we never hold all file contents at once, and the consumer can
 * apply back-pressure by awaiting each yield.
 *
 * Skip criteria (in order, cheapest first):
 *   1. Ignored by `buildIgnoreMatcher` (default set + .gitignore + caller).
 *   2. Extension not in `SUPPORTED_EXTENSIONS`.
 *   3. File size > `maxFileSize` (default 1 MB — avoids OOM on generated
 *      bundles / minified vendor code that slipped past ignore rules).
 *   4. Reading or parsing fails → `console.warn` and skip. tree-sitter is
 *      error-tolerant, so parse "failure" here means the native binding
 *      threw, not that the source had a syntax error.
 *
 * Hash: SHA256 of file contents, hex-encoded. Used downstream to decide
 * whether a re-ingest can skip a file whose bytes did not change.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Parser from 'tree-sitter';
import { buildIgnoreMatcher, type IgnoreMatcher } from './ignore';
import { detectLanguage, SUPPORTED_EXTENSIONS, type SupportedLanguage } from './language-detect';
import { parseFile } from './grammar-loader';

export interface WalkedFile {
  /** Absolute path on disk. Platform-native separators. */
  absolutePath: string;
  /** Path relative to the walk root, always forward-slash. */
  relativePath: string;
  /** Detected language; never null (files with no supported ext are skipped). */
  language: SupportedLanguage;
  /** UTF-8 contents. Read as a single buffer (bounded by `maxFileSize`). */
  content: string;
  /** Parsed tree. `tree.rootNode.hasError` may be true — tree-sitter is error-tolerant. */
  tree: Parser.Tree;
  /** SHA256 hex of raw UTF-8 bytes. */
  contentHash: string;
}

export interface WalkOptions {
  /** Extra patterns passed straight to `buildIgnoreMatcher`. */
  additionalIgnore?: string[];
  /** Files larger than this (in bytes) are skipped. Default 1 MB. */
  maxFileSize?: number;
  /** Stop after yielding this many files. Default unlimited. */
  maxFiles?: number;
  /** Called on every scanned directory entry so a progress bar can advance. */
  onProgress?: (scanned: number, indexed: number) => void;
}

/** 1 MB. Large enough for real source files, small enough to catch build blobs. */
const DEFAULT_MAX_FILE_SIZE = 1024 * 1024;

function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Walk `rootPath` recursively, yielding `WalkedFile` for every source file
 * we successfully parsed.
 *
 * The generator short-circuits as soon as the consumer stops pulling
 * (standard for-await-of semantics), so a caller that only needs the
 * first N files pays only for those N.
 */
export async function* walkRepo(
  rootPath: string,
  opts: WalkOptions = {},
): AsyncGenerator<WalkedFile> {
  const maxFileSize = opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const maxFiles = opts.maxFiles ?? Number.POSITIVE_INFINITY;
  const ignoreMatcher = buildIgnoreMatcher(rootPath, opts.additionalIgnore);
  const supportedExts = new Set(SUPPORTED_EXTENSIONS);

  let scanned = 0;
  let indexed = 0;

  // Fast `SUPPORTED_EXTENSIONS` ownership — the walker owns extension
  // filtering so it can reject files before opening them. `detectLanguage`
  // also checks, but its case-insensitive lookup requires the extension
  // anyway, so doing the cheap filter here avoids one extra allocation.
  function hasSupportedExt(name: string): boolean {
    const ext = path.extname(name).toLowerCase();
    return supportedExts.has(ext);
  }

  for await (const absolutePath of walkDirectory(rootPath, rootPath, ignoreMatcher)) {
    if (indexed >= maxFiles) return;

    scanned++;
    opts.onProgress?.(scanned, indexed);

    if (!hasSupportedExt(absolutePath)) continue;

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(absolutePath);
    } catch (err) {
      console.warn(`[walkRepo] stat failed for ${absolutePath}: ${errMsg(err)}`);
      continue;
    }

    if (!stat.isFile()) continue;
    if (stat.size > maxFileSize) continue;

    const language = detectLanguage(absolutePath);
    if (!language) continue;

    let content: string;
    try {
      content = await fs.promises.readFile(absolutePath, 'utf8');
    } catch (err) {
      console.warn(`[walkRepo] read failed for ${absolutePath}: ${errMsg(err)}`);
      continue;
    }

    let tree: Parser.Tree;
    try {
      tree = parseFile(content, language);
    } catch (err) {
      console.warn(`[walkRepo] parse failed for ${absolutePath}: ${errMsg(err)}`);
      continue;
    }

    const relativePath = toRelPath(rootPath, absolutePath);
    const contentHash = sha256Hex(content);
    indexed++;
    opts.onProgress?.(scanned, indexed);

    yield {
      absolutePath,
      relativePath,
      language,
      content,
      tree,
      contentHash,
    };

    if (indexed >= maxFiles) return;
  }
}

/**
 * Recursively yield absolute file paths under `dir`, pruning any directory
 * whose path-from-root is matched by `ignoreMatcher`. We prune at the
 * directory level (not just leaves) so we never recurse into
 * `node_modules/` at all — which is the whole point on large repos.
 */
async function* walkDirectory(
  root: string,
  dir: string,
  ignoreMatcher: IgnoreMatcher,
): AsyncGenerator<string> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`[walkRepo] readdir failed for ${dir}: ${errMsg(err)}`);
    return;
  }

  // Sort for deterministic iteration — helps tests and makes progress UIs
  // feel less jumpy. `readdir` order is filesystem-dependent.
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    const relPath = toRelPath(root, absolutePath);

    // For directories, append a trailing slash so the `ignore` pkg's
    // `dir/` patterns match. Without this, `node_modules/` in the default
    // set would not prune the directory itself (only files inside it).
    const matchPath = entry.isDirectory() ? `${relPath}/` : relPath;
    if (ignoreMatcher(matchPath)) continue;

    if (entry.isDirectory()) {
      yield* walkDirectory(root, absolutePath, ignoreMatcher);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      yield absolutePath;
    }
    // Other entry kinds (sockets, FIFOs) intentionally skipped.
  }
}

function toRelPath(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  // The `ignore` pkg requires forward slashes; normalise on Windows.
  return rel.split(path.sep).join('/');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
