import {
  loadGrammar,
  parseFile,
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

  it('loadGrammar("typescript") returns the same shared JS grammar (Wave 2 uses JS grammar for both)', () => {
    const js = loadGrammar('javascript');
    const ts = loadGrammar('typescript');
    expect(ts).toBe(js);
  });

  it('parseFile returns a program-rooted Tree with no errors for valid JS', () => {
    const tree = parseFile('const x = 1;\n', 'javascript');
    expect(tree.rootNode.type).toBe('program');
    expect(tree.rootNode.hasError).toBe(false);
  });
});
