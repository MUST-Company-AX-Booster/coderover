import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildIgnoreMatcher,
  DEFAULT_IGNORE_PATTERNS,
  readRootGitignore,
} from '../../../src/local/ingest/ignore';

/**
 * Integration tests for the local-mode ignore matcher. We do not re-test
 * the `ignore` npm package's gitignore semantics; we verify our stacking
 * order, default set, and boundary-case handling.
 */
describe('ignore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ignore-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('default set includes the Phase 10 C3 repo-noise roots', () => {
    expect(DEFAULT_IGNORE_PATTERNS).toContain('.git/');
    expect(DEFAULT_IGNORE_PATTERNS).toContain('node_modules/');
    expect(DEFAULT_IGNORE_PATTERNS).toContain('dist/');
    expect(DEFAULT_IGNORE_PATTERNS).toContain('build/');
    expect(DEFAULT_IGNORE_PATTERNS).toContain('.next/');
    expect(DEFAULT_IGNORE_PATTERNS).toContain('target/');
    expect(DEFAULT_IGNORE_PATTERNS).toContain('__pycache__/');
    expect(DEFAULT_IGNORE_PATTERNS).toContain('.coderover/');
    expect(DEFAULT_IGNORE_PATTERNS).toContain('coverage/');
  });

  it('defaults ignore build-output and tooling paths (no .gitignore needed)', () => {
    const m = buildIgnoreMatcher(tmpDir);
    expect(m('node_modules/foo.ts')).toBe(true);
    expect(m('.git/config')).toBe(true);
    expect(m('dist/main.js')).toBe(true);
    expect(m('coverage/lcov.info')).toBe(true);
  });

  it('does not ignore normal source paths by default', () => {
    const m = buildIgnoreMatcher(tmpDir);
    expect(m('src/foo.ts')).toBe(false);
    expect(m('README.md')).toBe(false);
    expect(m('coderover-api/src/index.ts')).toBe(false);
  });

  it('honors root .gitignore (custom/ pattern excludes custom/x.ts)', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'custom/\n*.local\n');
    const m = buildIgnoreMatcher(tmpDir);
    expect(m('custom/x.ts')).toBe(true);
    expect(m('config.local')).toBe(true);
    expect(m('src/main.ts')).toBe(false);

    // Sanity: readRootGitignore alone returns the raw lines.
    expect(readRootGitignore(tmpDir)).toEqual(
      expect.arrayContaining(['custom/', '*.local']),
    );
  });

  it('honors additionalIgnore from the caller', () => {
    const m = buildIgnoreMatcher(tmpDir, ['*.generated.ts']);
    expect(m('src/foo.generated.ts')).toBe(true);
    expect(m('src/foo.ts')).toBe(false);
  });

  it('directory pattern with or without trailing slash both match directory contents', () => {
    // Documented behaviour of `ignore@5.x`: both `dir/` and `dir` ignore
    // files inside `dir`. The `dir/` form additionally excludes ONLY
    // directories (not a file literally named `dir`), but for our walker
    // that distinction is cosmetic — we only recurse into directories.
    const withSlash = buildIgnoreMatcher(tmpDir, ['myout/']);
    expect(withSlash('myout/a.ts')).toBe(true);

    const withoutSlash = buildIgnoreMatcher(tmpDir, ['myout']);
    expect(withoutSlash('myout/a.ts')).toBe(true);
  });

  it('returns false for empty and parent-escape paths', () => {
    // Same behaviour as coderover-api/src/ingest/watch-ignore.ts: the
    // matcher refuses to answer for paths outside its scope instead of
    // guessing. Protects callers from accidentally swallowing the root.
    const m = buildIgnoreMatcher(tmpDir);
    expect(m('')).toBe(false);
    expect(m('../foo')).toBe(false);
    expect(m('../../outside/main.ts')).toBe(false);
  });
});
