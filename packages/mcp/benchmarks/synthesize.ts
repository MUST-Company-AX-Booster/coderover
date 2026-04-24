/**
 * Deterministic synthetic repo generator for local-mode MCP benchmarks.
 *
 * Writes a repo-shaped tree of mostly-valid TypeScript files to disk so
 * the ingest pipeline (walker → chunker → symbol-extractor →
 * import-extractor → embedder → SQLite) can be exercised at real-ish
 * scale without checking out a production codebase. Two guarantees the
 * benchmarks rely on:
 *
 *   1. **Reproducibility** — the same `seed + fileCount + avgLinesPerFile`
 *      triple produces byte-identical files across machines. Benchmark
 *      numbers are only comparable if the inputs are identical.
 *   2. **Realistic shape** — each file carries a class with 2–4 methods,
 *      a handful of imports (some relative to sibling synthesized files,
 *      some bare `pkg:` specifiers), plain bodies with loops and
 *      conditionals. That exercises the same chunker / symbol-extractor
 *      / import-extractor paths a real TS file would.
 *
 * Directory layout: `src/services/service-N.ts`. Flat under `src/services`
 * so the walker doesn't pay for deep recursion but the relative-import
 * resolver still has real siblings to resolve against.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface SynthesisOptions {
  /** Absolute path of an EMPTY directory to write into. Must exist. */
  rootDir: string;
  /** Number of `service-N.ts` files to generate. Default 200. */
  fileCount?: number;
  /**
   * Target line count per file — the generator lands within ±20% of this
   * (controlled by the seeded PRNG) so total LOC is predictable.
   * Default 50; at fileCount=200 that's 10k LOC.
   */
  avgLinesPerFile?: number;
  /** PRNG seed; fixed by default so reruns produce identical output. */
  seed?: number;
}

export interface SynthesisResult {
  /** Echoes `opts.rootDir` for convenience. */
  rootDir: string;
  /** Absolute paths to every generated file, in creation order. */
  files: string[];
  /** Sum of line counts across all generated files. */
  totalLines: number;
}

const DEFAULT_FILE_COUNT = 200;
const DEFAULT_AVG_LINES = 50;
const DEFAULT_SEED = 0xbeef;

/** Mulberry32 — tiny, deterministic, seeded PRNG. 32-bit internal state. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bare `pkg:` specifiers — one of these lands as the first import of each file. */
const BARE_PACKAGES = [
  'fs',
  'path',
  'crypto',
  'util',
  'events',
  'stream',
] as const;

/** Corpus of noun-ish tokens used to fabricate method names / identifiers. */
const VERB_CORPUS = [
  'fetch',
  'compute',
  'build',
  'resolve',
  'serialize',
  'parse',
  'validate',
  'render',
  'transform',
  'sync',
  'commit',
  'rollback',
  'invalidate',
  'hydrate',
  'enrich',
  'dispatch',
] as const;

const NOUN_CORPUS = [
  'record',
  'payload',
  'session',
  'token',
  'config',
  'cache',
  'manifest',
  'schema',
  'snapshot',
  'context',
  'document',
  'index',
  'fragment',
  'digest',
] as const;

/**
 * Synthesize a synthetic repo into `opts.rootDir`. Returns metadata the
 * benchmarks need (list of files, total lines) so they can report
 * "indexed X files, Y LOC" without a second disk walk.
 *
 * The caller is responsible for creating and cleaning up `rootDir`
 * (the benchmarks use `os.tmpdir()` + `fs.mkdtempSync`).
 */
export function synthesizeRepo(opts: SynthesisOptions): SynthesisResult {
  const fileCount = opts.fileCount ?? DEFAULT_FILE_COUNT;
  const avgLines = opts.avgLinesPerFile ?? DEFAULT_AVG_LINES;
  const seed = opts.seed ?? DEFAULT_SEED;

  if (!Number.isInteger(fileCount) || fileCount < 1) {
    throw new Error(`synthesizeRepo: fileCount must be a positive integer, got ${fileCount}`);
  }
  if (!Number.isInteger(avgLines) || avgLines < 10) {
    throw new Error(`synthesizeRepo: avgLinesPerFile must be an integer >= 10, got ${avgLines}`);
  }

  const rand = mulberry32(seed);
  const srcDir = path.join(opts.rootDir, 'src', 'services');
  fs.mkdirSync(srcDir, { recursive: true });

  const files: string[] = [];
  let totalLines = 0;

  for (let i = 0; i < fileCount; i++) {
    const content = generateFile(i, fileCount, avgLines, rand);
    const fileName = `service-${i}.ts`;
    const abs = path.join(srcDir, fileName);
    fs.writeFileSync(abs, content, 'utf8');
    files.push(abs);
    totalLines += content.split('\n').length;
  }

  return {
    rootDir: opts.rootDir,
    files,
    totalLines,
  };
}

/**
 * Produce the source text for one synthesized file. Deterministic for a
 * given `(index, fileCount, avgLines, rand)` — the PRNG is threaded
 * through so every call advances the same global sequence, which is
 * what makes `synthesizeRepo(seed=X)` byte-reproducible end-to-end.
 */
function generateFile(
  index: number,
  fileCount: number,
  avgLines: number,
  rand: () => number,
): string {
  const className = `Service${index}`;
  const methodCount = 2 + Math.floor(rand() * 3); // 2..4
  // Target ±20% of avgLines. Methods are the primary mass contributor,
  // so pick method length to hit the target after subtracting the
  // fixed class/import overhead (~12 lines).
  const targetLines = Math.max(20, Math.floor(avgLines * (0.8 + rand() * 0.4)));
  const fixedOverhead = 12;
  const bodyBudget = Math.max(methodCount * 4, targetLines - fixedOverhead);
  const linesPerMethod = Math.max(3, Math.floor(bodyBudget / methodCount));

  const lines: string[] = [];

  // Imports.
  lines.push(...generateImports(index, fileCount, rand));
  lines.push('');

  // Class header.
  lines.push(`/**`);
  lines.push(` * Synthetic service class ${className}.`);
  lines.push(` * Generated by benchmarks/synthesize.ts — do not edit.`);
  lines.push(` */`);
  lines.push(`export class ${className} {`);
  lines.push(`  private readonly id = ${index};`);
  lines.push('');

  // Methods.
  for (let m = 0; m < methodCount; m++) {
    lines.push(...generateMethod(index, m, linesPerMethod, rand));
    if (m !== methodCount - 1) lines.push('');
  }

  lines.push('}');
  lines.push('');
  lines.push(`export default ${className};`);
  lines.push('');

  return lines.join('\n');
}

/**
 * One bare import + 1–2 relative imports pointing at other synthesized
 * siblings. Relative targets are chosen from the PRNG so the resulting
 * import graph has non-trivial structure without being pathologically
 * cyclic.
 */
function generateImports(index: number, fileCount: number, rand: () => number): string[] {
  const lines: string[] = [];
  const pkg = BARE_PACKAGES[Math.floor(rand() * BARE_PACKAGES.length)];
  lines.push(`import * as _${pkg} from '${pkg}';`);

  const relCount = 1 + Math.floor(rand() * 2); // 1..2
  const seen = new Set<number>([index]); // don't import self
  for (let r = 0; r < relCount && fileCount > 1; r++) {
    let target = Math.floor(rand() * fileCount);
    // Walk forward until we find a fresh target — bounded by fileCount.
    let guard = 0;
    while (seen.has(target) && guard < fileCount) {
      target = (target + 1) % fileCount;
      guard++;
    }
    if (seen.has(target)) break;
    seen.add(target);
    lines.push(`import { Service${target} } from './service-${target}';`);
  }

  // Use the imported symbol so TypeScript's unused-import rules don't
  // flag the file if someone downstream runs a real tsc on the corpus.
  // Bench ingest doesn't care but keeping it syntactically "used" is
  // defensive.
  lines.push(`// reference: void _${pkg};`);

  return lines;
}

/**
 * Body of one method: `verbNoun()` name, returns a fabricated string,
 * has a seeded loop and a conditional so the chunker has something to
 * walk. Line count approximately `targetLines`, padded with comments
 * to hit the target deterministically.
 */
function generateMethod(
  index: number,
  methodIndex: number,
  targetLines: number,
  rand: () => number,
): string[] {
  const verb = VERB_CORPUS[Math.floor(rand() * VERB_CORPUS.length)];
  const noun = NOUN_CORPUS[Math.floor(rand() * NOUN_CORPUS.length)];
  const methodName = `${verb}${capitalize(noun)}${methodIndex}`;

  const lines: string[] = [];
  lines.push(`  /** ${capitalize(verb)} the ${noun} (${index}.${methodIndex}). */`);
  lines.push(`  public ${methodName}(limit: number = 0): string {`);
  lines.push(`    const prefix = '${verb}-${noun}';`);
  lines.push(`    const parts: string[] = [];`);
  lines.push(`    for (let i = 0; i < limit; i++) {`);
  lines.push(`      if (i % 2 === 0) {`);
  lines.push(`        parts.push(prefix + ':' + i);`);
  lines.push(`      } else {`);
  lines.push(`        parts.push(prefix + '#' + i);`);
  lines.push(`      }`);
  lines.push(`    }`);

  // Pad with bland comment lines to hit target — keeps the overall LOC
  // predictable regardless of which verb/noun we picked.
  const current = lines.length;
  const padNeeded = Math.max(0, targetLines - current - 2); // -2 for return + closer
  for (let p = 0; p < padNeeded; p++) {
    lines.push(`    // step ${p}: ${noun} pipeline is advancing deterministically.`);
  }

  lines.push(`    return parts.join(',') || prefix;`);
  lines.push(`  }`);

  return lines;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
