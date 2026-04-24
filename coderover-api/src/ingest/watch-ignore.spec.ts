import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildIgnoreMatcher,
  DEFAULT_IGNORE_PATTERNS,
  readRootGitignore,
} from './watch-ignore';

/**
 * Phase 10 C3 — watch-ignore tests.
 *
 * We wrap the `ignore` npm package so we don't re-test its gitignore
 * semantics in detail. Tests verify our integration: the three pattern
 * sources stack in the right order, missing `.gitignore` degrades
 * cleanly, path boundary conditions don't trip the matcher.
 */
describe('watch-ignore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-ignore-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('DEFAULT_IGNORE_PATTERNS', () => {
    it('includes the canonical repo-noise roots', () => {
      expect(DEFAULT_IGNORE_PATTERNS).toContain('.git/');
      expect(DEFAULT_IGNORE_PATTERNS).toContain('node_modules/');
      expect(DEFAULT_IGNORE_PATTERNS).toContain('dist/');
      expect(DEFAULT_IGNORE_PATTERNS).toContain('.coderover-cache/');
    });
  });

  describe('readRootGitignore', () => {
    it('returns an empty array when no .gitignore exists', () => {
      expect(readRootGitignore(tmpDir)).toEqual([]);
    });

    it('reads and splits the root .gitignore', () => {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'foo/\n*.log\n');
      const lines = readRootGitignore(tmpDir);
      expect(lines).toContain('foo/');
      expect(lines).toContain('*.log');
    });
  });

  describe('buildIgnoreMatcher', () => {
    it('ignores .git, node_modules, dist by default (no .gitignore needed)', () => {
      const m = buildIgnoreMatcher(tmpDir);
      expect(m('.git/HEAD')).toBe(true);
      expect(m('node_modules/foo/index.js')).toBe(true);
      expect(m('dist/main.js')).toBe(true);
      expect(m('dist/nested/deep/file.js')).toBe(true);
    });

    it('does not ignore normal source paths', () => {
      const m = buildIgnoreMatcher(tmpDir);
      expect(m('src/main.ts')).toBe(false);
      expect(m('coderover-api/src/ingest/watch-daemon.service.ts')).toBe(false);
    });

    it('ignores .coderover-cache contents', () => {
      const m = buildIgnoreMatcher(tmpDir);
      expect(m('.coderover-cache/entries/foo.bin')).toBe(true);
    });

    it('honors root .gitignore patterns', () => {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'secret/\n*.local\n');
      const m = buildIgnoreMatcher(tmpDir);
      expect(m('secret/x')).toBe(true);
      expect(m('config.local')).toBe(true);
      expect(m('src/main.ts')).toBe(false);
    });

    it('honors additionalIgnore patterns from the caller', () => {
      const m = buildIgnoreMatcher(tmpDir, ['**/*.tmp', 'scripts/generated/**']);
      expect(m('foo.tmp')).toBe(true);
      expect(m('src/deep/x.tmp')).toBe(true);
      expect(m('scripts/generated/out.ts')).toBe(true);
      expect(m('scripts/hand/written.ts')).toBe(false);
    });

    it('stacks pattern sources: defaults + gitignore + additional', () => {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'cache/\n');
      const m = buildIgnoreMatcher(tmpDir, ['*.draft']);
      expect(m('.git/HEAD')).toBe(true); // default
      expect(m('cache/x')).toBe(true); // gitignore
      expect(m('report.draft')).toBe(true); // additional
      expect(m('src/main.ts')).toBe(false);
    });

    it('survives a missing .gitignore without throwing', () => {
      const m = buildIgnoreMatcher('/nonexistent-path-xyz-hopefully');
      expect(m('.git/HEAD')).toBe(true);
      expect(m('src/main.ts')).toBe(false);
    });

    it('returns false for empty or parent-escape paths', () => {
      const m = buildIgnoreMatcher(tmpDir);
      expect(m('')).toBe(false);
      expect(m('../outside/main.ts')).toBe(false);
    });
  });
});
