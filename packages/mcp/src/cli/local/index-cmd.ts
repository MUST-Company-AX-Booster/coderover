/**
 * Phase 11 Wave 4 — L17: `coderover index` CLI.
 *
 *   coderover index [path] [--embed mock|openai|offline] [--verbose] [--help]
 *
 * Walks the project root at `path` (default cwd), opens the SQLite DB
 * under `~/.coderover/<sha>.db`, runs migrations, and indexes every
 * supported source file — incrementally by default. Files whose SHA256
 * matches the stored `file_hashes.sha256` are skipped.
 *
 * The CLI is a thin adapter: heavy lifting lives in `pipeline.ts`. This
 * file owns argv parsing, help text, and result formatting only.
 */

import type Database from 'better-sqlite3';

import { indexRepo, type IndexRepoResult } from '../../local/pipeline';
import type { Embedder } from '../../local/embed/types';
import {
  buildEmbedder,
  openIndexedDb,
  resolveDbPath,
  resolveProjectRoot,
} from './shared';
import { touchMeta } from './meta';

/** Parsed CLI arguments. */
export interface IndexCmdArgs {
  path?: string;
  embed?: 'mock' | 'openai' | 'offline';
  verbose?: boolean;
  help?: boolean;
  /** Unknown token — surfaced as an error at run-time. */
  unknown?: string;
}

/** Dependencies the caller can inject (mostly for tests). */
export interface IndexCmdDeps {
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** Test seam — substitute the DB path resolver. */
  resolveDbPath?: (projectRoot: string) => string;
  /** Test seam — substitute the embedder builder. */
  buildEmbedder?: (mode?: 'mock' | 'openai' | 'offline') => Embedder;
  /** Test seam — substitute the project-root resolver. */
  resolveProjectRoot?: (input: string | undefined) => string;
  /** Test seam — substitute the DB opener. */
  openIndexedDb?: (dbPath: string) => Promise<Database.Database>;
  /** Capture stdout/stderr. Defaults to process streams. */
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/**
 * Parse argv for the `index` subcommand.
 *
 * The parser is intentionally hand-rolled (no commander/yargs) to
 * match the rest of the CLI and keep install size low.
 */
export function parseIndexArgs(argv: string[]): IndexCmdArgs {
  const out: IndexCmdArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--help' || tok === '-h') {
      out.help = true;
      continue;
    }
    if (tok === '--verbose') {
      out.verbose = true;
      continue;
    }
    if (tok === '--embed') {
      const val = argv[i + 1];
      if (val === 'mock' || val === 'openai' || val === 'offline') {
        out.embed = val;
        i++;
        continue;
      }
      out.unknown = `--embed requires mock|openai|offline, got ${val ?? '<none>'}`;
      // Consume the bad value so it isn't re-parsed as a positional.
      if (val !== undefined) i++;
      continue;
    }
    if (tok.startsWith('--embed=')) {
      const val = tok.slice('--embed='.length);
      if (val === 'mock' || val === 'openai' || val === 'offline') {
        out.embed = val;
        continue;
      }
      out.unknown = `--embed requires mock|openai|offline, got ${val}`;
      continue;
    }
    if (tok.startsWith('--')) {
      out.unknown = `unknown flag: ${tok}`;
      continue;
    }
    // Positional.
    if (out.path === undefined) {
      out.path = tok;
    } else {
      out.unknown = `unexpected positional: ${tok}`;
    }
  }
  return out;
}

export function helpText(): string {
  return [
    'coderover index [path] [--embed mock|openai|offline] [--verbose]',
    '',
    'Index the project at [path] (default: cwd) into the local SQLite store',
    'at ~/.coderover/<sha>.db. Incremental by default — files whose content',
    'hash matches the stored one are skipped.',
    '',
    'FLAGS',
    '  --embed mock|openai|offline  Embedder mode. Default: openai (mock fallback if',
    '                       OPENAI_API_KEY is unset). Overrides the',
    '                       CODEROVER_EMBED_MODE env var.',
    '  --verbose            Print one line per indexed file.',
    '  -h, --help           Show this message.',
    '',
    'ENVIRONMENT',
    '  CODEROVER_EMBED_MODE  mock | openai (default openai)',
    '  OPENAI_API_KEY        Required for --embed openai.',
    '',
  ].join('\n');
}

/**
 * Execute `coderover index`. Returns a POSIX exit code:
 *
 *   0 → success
 *   1 → runtime failure (DB open, embed, write)
 *   2 → bad CLI usage (unknown flag, bad value)
 */
export async function runIndexCmd(
  argv: string[],
  deps: IndexCmdDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const _resolveProjectRoot = deps.resolveProjectRoot ?? resolveProjectRoot;
  const _resolveDbPath = deps.resolveDbPath ?? resolveDbPath;
  const _buildEmbedder = deps.buildEmbedder ?? buildEmbedder;
  const _openIndexedDb = deps.openIndexedDb ?? openIndexedDb;

  const args = parseIndexArgs(argv);
  if (args.help) {
    stdout.write(helpText());
    return 0;
  }
  if (args.unknown) {
    stderr.write(`[coderover index] ${args.unknown}\n`);
    return 2;
  }

  const projectRoot = _resolveProjectRoot(args.path);
  const dbPath = _resolveDbPath(projectRoot);

  let db: Database.Database;
  try {
    db = await _openIndexedDb(dbPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`[coderover index] failed to open database at ${dbPath}: ${msg}\n`);
    return 1;
  }
  touchMeta(dbPath, projectRoot);

  const embedder = _buildEmbedder(args.embed);

  try {
    const started = Date.now();
    stdout.write(`[coderover index] root=${projectRoot}\n`);
    stdout.write(`[coderover index] db=${dbPath}\n`);

    const result: IndexRepoResult = await indexRepo({
      db,
      embedder,
      rootPath: projectRoot,
      incremental: true,
      onProgress: args.verbose
        ? (p) => {
            stdout.write(
              `[coderover index] ${p.done}: ${p.skipped ? 'skip' : `index (${p.chunks} chunks)`} ${p.file}\n`,
            );
          }
        : undefined,
    });

    const elapsedMs = Date.now() - started;
    stdout.write(formatResultTable(result, elapsedMs));
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`[coderover index] failed: ${msg}\n`);
    return 1;
  } finally {
    try {
      db.close();
    } catch {
      // Already closed or never fully opened — nothing to do.
    }
  }
}

function formatResultTable(result: IndexRepoResult, elapsedMs: number): string {
  const lines = [
    '',
    `files      ${result.files}`,
    `indexed    ${result.filesIndexed}`,
    `skipped    ${result.filesSkipped}`,
    `chunks     ${result.chunks}`,
    `symbols    ${result.symbols}`,
    `imports    ${result.imports}`,
    `elapsed    ${(elapsedMs / 1000).toFixed(2)}s`,
    '',
  ];
  return lines.join('\n');
}
