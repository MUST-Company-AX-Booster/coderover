import {
  loadGrammar,
  parseFile,
  isTypeScriptCompanionAvailable,
  __setTypeScriptRequireForTests,
  __clearGrammarCacheForTests,
} from '../../../src/local/ingest/grammar-loader';
import type { SupportedLanguage } from '../../../src/local/ingest/language-detect';

// Gated on TS_REAL=1 — tree-sitter cross-spec flake (see tree-sitter-singleton.ts).
const realDescribe = process.env.TS_REAL === '1' ? describe : describe.skip;

// Non-grammar tests always run.
describe('grammar-loader (no-parse)', () => {
  it('loadGrammar throws a clear error for a truly unknown language', () => {
    // Wave 4 added python/go/java as first-class members of
    // `SupportedLanguage`, so we reach for a synthetic value that the
    // switch's exhaustiveness guard must still reject.
    expect(() =>
      loadGrammar('klingon' as unknown as SupportedLanguage),
    ).toThrow(/unsupported language/i);
  });
});

realDescribe('grammar-loader (real parse)', () => {
  it('loadGrammar("javascript") returns a truthy grammar and caches it', () => {
    const first = loadGrammar('javascript');
    expect(first).toBeTruthy();
    const second = loadGrammar('javascript');
    expect(second).toBe(first);
  });

  it('parseFile returns a program-rooted Tree with no errors for valid JS', () => {
    const tree = parseFile('const x = 1;\n', 'javascript');
    expect(tree.rootNode.type).toBe('program');
    expect(tree.rootNode.hasError).toBe(false);
  });
});

// 0.5.0 — TS grammar dispatch (B3). The probe seam lets us simulate the
// companion's presence/absence without touching node_modules.
describe('grammar-loader (TS companion dispatch — 0.5.0)', () => {
  // Capture stderr writes so the one-shot fallback warning doesn't
  // pollute test output and so we can assert it fires when expected.
  let stderrWrites: string[] = [];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrWrites = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    __setTypeScriptRequireForTests(undefined);
    __clearGrammarCacheForTests();
  });

  it('falls back to JS grammar with a one-line stderr warning when the companion is absent', () => {
    __setTypeScriptRequireForTests((id: string) => {
      if (id === 'tree-sitter-typescript') {
        const e: NodeJS.ErrnoException = new Error(
          "Cannot find module 'tree-sitter-typescript'",
        );
        e.code = 'MODULE_NOT_FOUND';
        throw e;
      }
      // Defer everything else to the real require.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(id);
    });
    expect(isTypeScriptCompanionAvailable()).toBe(false);
    const warning = stderrWrites.join('');
    expect(warning).toMatch(/tree-sitter-typescript not installed/);
    expect(warning).toMatch(/@coderover\/mcp-typescript/);
  });

  it('uses the companion grammar when the require resolves', () => {
    const stubGrammar = { __id: 'fake-ts-grammar' };
    __setTypeScriptRequireForTests((id: string) => {
      if (id === 'tree-sitter-typescript') {
        return { typescript: stubGrammar };
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(id);
    });
    const grammar = loadGrammar('typescript');
    expect(grammar).toBe(stubGrammar);
    expect(isTypeScriptCompanionAvailable()).toBe(true);
    // No fallback warning when the companion resolves.
    const warning = stderrWrites.join('');
    expect(warning).not.toMatch(/not installed/);
  });

  it('only emits the fallback warning once per process (probe is cached)', () => {
    __setTypeScriptRequireForTests((id: string) => {
      if (id === 'tree-sitter-typescript') {
        const e: NodeJS.ErrnoException = new Error(
          "Cannot find module 'tree-sitter-typescript'",
        );
        e.code = 'MODULE_NOT_FOUND';
        throw e;
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(id);
    });
    isTypeScriptCompanionAvailable();
    isTypeScriptCompanionAvailable();
    isTypeScriptCompanionAvailable();
    const warningCount = stderrWrites.filter((s) =>
      s.includes('tree-sitter-typescript not installed'),
    ).length;
    expect(warningCount).toBe(1);
  });
});
