/**
 * Phase 11 Wave 4 — L20: tests for Python/Go/Java language detection.
 *
 * These tests exist as a sibling to `language-detect.spec.ts` (which
 * continues to cover JS/TS) so the wave's additions are self-contained and
 * easy to review. If a future wave adds Rust/Kotlin/PHP, this file is the
 * template to copy.
 *
 * Coverage:
 *   - `.py` / `.pyw` → python
 *   - `.go`          → go
 *   - `.java`        → java
 *   - JS/TS still resolve (regression guard)
 *   - Uppercase extensions resolve (cross-platform casing policy)
 *   - Unknown extensions return null
 */

import {
  detectLanguage,
  SUPPORTED_EXTENSIONS,
  type SupportedLanguage,
} from '../../../src/local/ingest/language-detect';

describe('language-detect (Wave 4 multi-language)', () => {
  describe('Python', () => {
    it.each<[string, SupportedLanguage]>([
      ['src/mod.py', 'python'],
      ['src/gui.pyw', 'python'],
      ['deeply/nested/file.py', 'python'],
    ])('maps %s to python', (filePath, expected) => {
      expect(detectLanguage(filePath)).toBe(expected);
    });
  });

  describe('Go', () => {
    it('maps .go to go', () => {
      expect(detectLanguage('cmd/server.go')).toBe('go');
    });

    it('also handles test files (.go)', () => {
      expect(detectLanguage('internal/widget_test.go')).toBe('go');
    });
  });

  describe('Java', () => {
    it('maps .java to java', () => {
      expect(detectLanguage('src/main/java/com/example/Foo.java')).toBe('java');
    });
  });

  describe('regression: JS/TS still resolve', () => {
    it('.js -> javascript', () => {
      expect(detectLanguage('src/a.js')).toBe('javascript');
    });
    it('.ts -> typescript', () => {
      expect(detectLanguage('src/a.ts')).toBe('typescript');
    });
    it('.tsx -> typescript', () => {
      expect(detectLanguage('src/a.tsx')).toBe('typescript');
    });
  });

  describe('case-insensitive extension matching', () => {
    it.each<[string, SupportedLanguage]>([
      ['Legacy.PY', 'python'],
      ['cmd/Main.GO', 'go'],
      ['com/example/Bean.JAVA', 'java'],
    ])('maps %s to %s (uppercase)', (filePath, expected) => {
      expect(detectLanguage(filePath)).toBe(expected);
    });

    it('mixed case also resolves (.Py, .Go, .Java)', () => {
      expect(detectLanguage('src/x.Py')).toBe('python');
      expect(detectLanguage('src/x.Go')).toBe('go');
      expect(detectLanguage('src/x.Java')).toBe('java');
    });
  });

  describe('unknown extensions', () => {
    it('.rs is not yet supported -> null', () => {
      // Sanity: Rust lives in a future wave — this guard fails loudly if
      // someone accidentally drops Rust in without wiring the grammar.
      expect(detectLanguage('src/a.rs')).toBeNull();
    });

    it('.kt / .php still return null', () => {
      expect(detectLanguage('src/a.kt')).toBeNull();
      expect(detectLanguage('src/a.php')).toBeNull();
    });

    it('unrelated files return null', () => {
      expect(detectLanguage('README.md')).toBeNull();
      expect(detectLanguage('Dockerfile')).toBeNull();
      expect(detectLanguage('no-ext')).toBeNull();
    });
  });

  describe('SUPPORTED_EXTENSIONS includes Wave 4 additions', () => {
    it('contains the 4 new Wave 4 extensions', () => {
      const s = new Set(SUPPORTED_EXTENSIONS);
      expect(s.has('.py')).toBe(true);
      expect(s.has('.pyw')).toBe(true);
      expect(s.has('.go')).toBe(true);
      expect(s.has('.java')).toBe(true);
    });

    it('still contains every Wave 2 extension (regression guard)', () => {
      const s = new Set(SUPPORTED_EXTENSIONS);
      for (const ext of ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']) {
        expect(s.has(ext)).toBe(true);
      }
    });
  });
});
