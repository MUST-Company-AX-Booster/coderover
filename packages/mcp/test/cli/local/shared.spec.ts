/**
 * Unit tests for `src/cli/local/shared.ts` and `defaultDbPath` in
 * `src/cli/install.ts`.
 *
 * Bug #4: pre-0.5.1 `resolveDbPath` hashed `path.resolve(projectRoot)`,
 * so the same physical directory reachable through a symlink (e.g.
 * `/tmp/foo` → `/private/tmp/foo` on macOS, container bind-mounts on
 * Linux) produced two different DB hashes — and therefore two
 * separately-maintained indices for what the user thinks is one repo.
 * The fix: canonicalize via `realpath` before hashing.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildEmbedder,
  resolveDbPath,
  resolveProjectRoot,
} from '../../../src/cli/local/shared';
import { defaultDbPath } from '../../../src/cli/install';

function mkRealAndSymlink(): {
  realDir: string;
  linkDir: string;
  cleanup: () => void;
} {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'coderover-realpath-'));
  const realDir = path.join(parent, 'real');
  const linkDir = path.join(parent, 'link');
  fs.mkdirSync(realDir);
  fs.symlinkSync(realDir, linkDir, 'dir');
  return {
    realDir,
    linkDir,
    cleanup: () => fs.rmSync(parent, { recursive: true, force: true }),
  };
}

describe('resolveDbPath — symlink canonicalization', () => {
  it('produces the same DB path for a real dir and a symlink to it', () => {
    const { realDir, linkDir, cleanup } = mkRealAndSymlink();
    try {
      const a = resolveDbPath(realDir);
      const b = resolveDbPath(linkDir);
      expect(a).toBe(b);
    } finally {
      cleanup();
    }
  });

  it('falls back to path.resolve when the path does not exist yet', () => {
    const ghost = path.join(os.tmpdir(), `coderover-no-such-dir-${Date.now()}`);
    expect(() => resolveDbPath(ghost)).not.toThrow();
    expect(resolveDbPath(ghost)).toMatch(/\.coderover\/[a-f0-9]{16}\.db$/);
  });
});

describe('resolveProjectRoot — explicit path should not walk up', () => {
  // Bug #5: pre-0.5.1 `resolveProjectRoot('./subdir')` walked up looking
  // for a project marker (package.json, .git, …). If a parent dir had
  // any of those, the explicit subdir was silently ignored — `index
  // ./my-repo` from a directory that happens to have a top-level
  // package.json would index the parent. Walk-up is correct ONLY for
  // the no-arg / cwd case ("find the project I'm in").

  function mkParentChildLayout(): { parent: string; child: string; cleanup: () => void } {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'coderover-walkup-'));
    fs.writeFileSync(path.join(parent, 'package.json'), '{"name":"parent"}', 'utf8');
    const child = path.join(parent, 'inner');
    fs.mkdirSync(child);
    return {
      parent,
      child,
      cleanup: () => fs.rmSync(parent, { recursive: true, force: true }),
    };
  }

  it('returns the explicit path when no marker is in the directory', () => {
    const { child, cleanup } = mkParentChildLayout();
    try {
      const got = resolveProjectRoot(child);
      // Compare via realpath so macOS /private/tmp aliases don't trip us.
      expect(fs.realpathSync(got)).toBe(fs.realpathSync(child));
    } finally {
      cleanup();
    }
  });

  it('still returns the explicit path when a parent has a marker', () => {
    const { parent, child, cleanup } = mkParentChildLayout();
    try {
      const got = resolveProjectRoot(child);
      expect(fs.realpathSync(got)).not.toBe(fs.realpathSync(parent));
      expect(fs.realpathSync(got)).toBe(fs.realpathSync(child));
    } finally {
      cleanup();
    }
  });

  it('returns the explicit path even when it itself has a marker', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'coderover-walkup-'));
    const child = path.join(parent, 'has-marker');
    try {
      fs.mkdirSync(child);
      fs.writeFileSync(path.join(child, 'package.json'), '{"name":"child"}', 'utf8');
      const got = resolveProjectRoot(child);
      expect(fs.realpathSync(got)).toBe(fs.realpathSync(child));
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('walks up from cwd when called with no arg (preserved behavior)', () => {
    const { parent, child, cleanup } = mkParentChildLayout();
    const savedCwd = process.cwd();
    try {
      process.chdir(child);
      // No argument → walk up from cwd, find parent's package.json.
      const got = resolveProjectRoot(undefined);
      expect(fs.realpathSync(got)).toBe(fs.realpathSync(parent));
    } finally {
      process.chdir(savedCwd);
      cleanup();
    }
  });
});

describe('buildEmbedder("offline") — sync probe for companion package', () => {
  // Bug #2 follow-up: the OfflineEmbedder constructor doesn't probe
  // @xenova/transformers — the require happens lazily on first .embed().
  // For the reindex pre-flight check to actually catch a missing
  // companion before unlinking the DB, buildEmbedder('offline') must
  // probe synchronously and throw with the same clear install hint.
  // This test only runs when @xenova/transformers is NOT installed in
  // the dev tree (the default — the package is the heavyweight
  // companion, deliberately not a dep of the parent).
  let companionPresent = true;
  try {
    require.resolve('@xenova/transformers');
  } catch {
    companionPresent = false;
  }

  const itIfNoCompanion = companionPresent ? it.skip : it;

  itIfNoCompanion(
    'throws synchronously with the install hint when companion is missing',
    () => {
      expect(() => buildEmbedder('offline')).toThrow(
        /@coderover\/mcp-offline/,
      );
    },
  );
});

describe('defaultDbPath — symlink canonicalization', () => {
  it('matches resolveDbPath byte-for-byte through a symlink', () => {
    const { realDir, linkDir, cleanup } = mkRealAndSymlink();
    try {
      // The two installer paths must agree with the index/watch path so
      // the agent config and the index command open the same DB file.
      const installerViaReal = defaultDbPath(realDir);
      const installerViaLink = defaultDbPath(linkDir);
      const indexerViaReal = resolveDbPath(realDir);
      const indexerViaLink = resolveDbPath(linkDir);
      expect(installerViaReal).toBe(installerViaLink);
      expect(installerViaReal).toBe(indexerViaReal);
      expect(installerViaLink).toBe(indexerViaLink);
    } finally {
      cleanup();
    }
  });
});
