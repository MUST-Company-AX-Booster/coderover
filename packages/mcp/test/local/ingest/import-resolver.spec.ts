/**
 * Tests for Phase 11 Wave 2 L8 — `import-resolver.ts`.
 *
 * Covers every documented branch of `resolveImport`:
 *   - relative with explicit extension
 *   - relative without extension: resolves `.ts`, `.js`, `<dir>/index.*`
 *   - relative unresolved (no file matches)
 *   - relative escaping the repo root -> absolute result
 *   - absolute `/...`
 *   - bare (plain pkg, scoped pkg, Node built-in)
 *
 * Filesystem-touching tests use `fs.mkdtempSync(os.tmpdir(), ...)` so they
 * don't pollute the repo tree.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resolveImport } from '../../../src/local/ingest/import-resolver';

describe('resolveImport', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-imp-resolver-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Helper: write an empty file under the tmp repo and return its abs path. */
  function touch(relative: string): string {
    const abs = path.join(tmpRoot, relative);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '');
    return abs;
  }

  it('relative with explicit .ts extension returns repo-relative path', () => {
    const srcAbs = touch('src/a.ts');
    touch('src/foo.ts');

    const result = resolveImport('./foo.ts', srcAbs, tmpRoot);

    expect(result.kind).toBe('relative');
    expect(result.raw).toBe('./foo.ts');
    expect(result.resolvedPath).toBe('src/foo.ts');
  });

  it('relative without extension resolves to .ts when present', () => {
    const srcAbs = touch('src/a.ts');
    touch('src/foo.ts');

    const result = resolveImport('./foo', srcAbs, tmpRoot);

    expect(result.kind).toBe('relative');
    expect(result.resolvedPath).toBe('src/foo.ts');
  });

  it('prefers .ts over .js when both exist (priority order)', () => {
    const srcAbs = touch('src/a.ts');
    touch('src/foo.ts');
    touch('src/foo.js');

    const result = resolveImport('./foo', srcAbs, tmpRoot);

    // Priority: .ts beats .js — matches the CANDIDATE_EXTENSIONS order.
    expect(result.resolvedPath).toBe('src/foo.ts');
  });

  it('resolves .js when only .js exists (.ts missing)', () => {
    const srcAbs = touch('src/a.ts');
    touch('src/only-js.js');

    const result = resolveImport('./only-js', srcAbs, tmpRoot);

    expect(result.kind).toBe('relative');
    expect(result.resolvedPath).toBe('src/only-js.js');
  });

  it('resolves <spec>/index.ts when <spec> is a directory', () => {
    const srcAbs = touch('src/a.ts');
    touch('src/lib/index.ts');

    const result = resolveImport('./lib', srcAbs, tmpRoot);

    expect(result.kind).toBe('relative');
    expect(result.resolvedPath).toBe('src/lib/index.ts');
  });

  it('resolves <spec>/index.js when only index.js exists', () => {
    const srcAbs = touch('src/a.ts');
    touch('src/lib/index.js');

    const result = resolveImport('./lib', srcAbs, tmpRoot);

    expect(result.resolvedPath).toBe('src/lib/index.js');
  });

  it('unresolved relative falls back to extensionless repo-relative stub', () => {
    const srcAbs = touch('src/a.ts');
    // Deliberately do NOT create `./missing` anywhere.

    const result = resolveImport('./missing', srcAbs, tmpRoot);

    expect(result.kind).toBe('relative');
    expect(result.raw).toBe('./missing');
    // Resolver returns the target path without extension — document the
    // decision so Wave 3's find_dependencies can still match against it.
    expect(result.resolvedPath).toBe('src/missing');
  });

  it('unresolved nested relative (../other/missing) is still emitted', () => {
    const srcAbs = touch('src/deep/a.ts');

    const result = resolveImport('../other/missing', srcAbs, tmpRoot);

    expect(result.kind).toBe('relative');
    expect(result.resolvedPath).toBe('src/other/missing');
  });

  it('relative escaping repo root returns absolute resolvedPath', () => {
    // srcFile is inside the tmp repo; the specifier `../../external/x`
    // escapes `tmpRoot` and should come back as an absolute path.
    const srcAbs = touch('src/a.ts');

    const result = resolveImport('../../external/x', srcAbs, tmpRoot);

    expect(result.kind).toBe('relative');
    expect(result.resolvedPath).toBeDefined();
    expect(path.isAbsolute(result.resolvedPath!)).toBe(true);
    // And it must be outside tmpRoot.
    expect(result.resolvedPath!.startsWith(tmpRoot + path.sep)).toBe(false);
  });

  it('absolute /abs/path is returned verbatim', () => {
    const srcAbs = touch('src/a.ts');

    const result = resolveImport('/etc/hosts', srcAbs, tmpRoot);

    expect(result.kind).toBe('absolute');
    expect(result.raw).toBe('/etc/hosts');
    expect(result.resolvedPath).toBe('/etc/hosts');
  });

  it('bare npm package: "lodash" -> kind=bare, no resolvedPath', () => {
    const srcAbs = touch('src/a.ts');

    const result = resolveImport('lodash', srcAbs, tmpRoot);

    expect(result.kind).toBe('bare');
    expect(result.raw).toBe('lodash');
    expect(result.resolvedPath).toBeUndefined();
  });

  it('bare scoped package: "@foo/bar" -> bare', () => {
    const srcAbs = touch('src/a.ts');

    const result = resolveImport('@foo/bar', srcAbs, tmpRoot);

    expect(result.kind).toBe('bare');
    expect(result.raw).toBe('@foo/bar');
    expect(result.resolvedPath).toBeUndefined();
  });

  it('bare subpath: "lodash/fp" -> bare', () => {
    const srcAbs = touch('src/a.ts');

    const result = resolveImport('lodash/fp', srcAbs, tmpRoot);

    expect(result.kind).toBe('bare');
    expect(result.raw).toBe('lodash/fp');
  });

  it('Node built-in "fs" is bare', () => {
    const srcAbs = touch('src/a.ts');

    const result = resolveImport('fs', srcAbs, tmpRoot);

    expect(result.kind).toBe('bare');
    expect(result.raw).toBe('fs');
    expect(result.resolvedPath).toBeUndefined();
  });

  it('Node built-in "node:fs" is bare', () => {
    const srcAbs = touch('src/a.ts');

    const result = resolveImport('node:fs', srcAbs, tmpRoot);

    expect(result.kind).toBe('bare');
    expect(result.resolvedPath).toBeUndefined();
  });

  it('relative with .tsx prefers .tsx when both .ts and .tsx exist', () => {
    const srcAbs = touch('src/a.tsx');
    touch('src/component.ts');
    touch('src/component.tsx');

    const result = resolveImport('./component', srcAbs, tmpRoot);

    // CANDIDATE_EXTENSIONS order puts .ts before .tsx, so .ts wins.
    // Lock that behaviour so it surfaces in review if we later reorder.
    expect(result.resolvedPath).toBe('src/component.ts');
  });
});
