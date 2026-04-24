import {
  detectLanguage,
  SUPPORTED_EXTENSIONS,
  type SupportedLanguage,
} from '../../../src/local/ingest/language-detect';

describe('language-detect', () => {
  describe('detectLanguage', () => {
    it.each<[string, SupportedLanguage]>([
      ['src/foo.ts', 'typescript'],
      ['src/foo.tsx', 'typescript'],
      ['src/foo.mts', 'typescript'],
      ['src/foo.cts', 'typescript'],
    ])('maps %s to typescript', (filePath, expected) => {
      expect(detectLanguage(filePath)).toBe(expected);
    });

    it.each<[string, SupportedLanguage]>([
      ['src/foo.js', 'javascript'],
      ['src/foo.jsx', 'javascript'],
      ['src/foo.mjs', 'javascript'],
      ['src/foo.cjs', 'javascript'],
    ])('maps %s to javascript', (filePath, expected) => {
      expect(detectLanguage(filePath)).toBe(expected);
    });

    it('returns null for unsupported and missing extensions', () => {
      // Wave 4 added Python/Go/Java — former "unsupported" examples like
      // `.py` / `.go` now resolve. Assert against extensions that remain
      // out-of-scope (Rust/Kotlin/PHP deferred to a later wave) and the
      // no-extension case.
      expect(detectLanguage('src/foo.rs')).toBeNull();
      expect(detectLanguage('src/foo.kt')).toBeNull();
      expect(detectLanguage('src/foo.php')).toBeNull();
      expect(detectLanguage('README.md')).toBeNull();
      expect(detectLanguage('Makefile')).toBeNull();
      expect(detectLanguage('no-ext')).toBeNull();
    });

    it('is case-insensitive (.TS, .JSX both resolve)', () => {
      // Documented behaviour: macOS / legacy Windows repos ship files as
      // Foo.TS or index.JSX. We treat extensions case-insensitively so
      // local mode does not silently skip them.
      expect(detectLanguage('Foo.TS')).toBe('typescript');
      expect(detectLanguage('index.JSX')).toBe('javascript');
      expect(detectLanguage('thing.MJS')).toBe('javascript');
    });
  });

  describe('SUPPORTED_EXTENSIONS', () => {
    it('contains the 8 Wave 2 JS/TS extensions plus Wave 4 Python/Go/Java', () => {
      // Wave 2 shipped 8 JS/TS extensions; Wave 4 adds 4 more (.py, .pyw,
      // .go, .java) for a total of 12.
      expect(SUPPORTED_EXTENSIONS).toHaveLength(12);
      expect(new Set(SUPPORTED_EXTENSIONS)).toEqual(
        new Set([
          '.js', '.jsx', '.mjs', '.cjs',
          '.ts', '.tsx', '.mts', '.cts',
          '.py', '.pyw',
          '.go',
          '.java',
        ]),
      );
    });
  });
});
