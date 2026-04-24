#!/usr/bin/env node
/**
 * @coderover/mcp CLI shim.
 *
 * Boots `dist/cli/index.js` (preferred) with a ts-node dev fallback so
 * `node bin/coderover-mcp.js` works from a fresh checkout without `npm run
 * build` every time. Production installs always use the compiled dist tree.
 *
 * Subcommand dispatch (install / uninstall / doctor / upgrade) lives in
 * `src/cli/index.ts` — this file just wires argv and stdio.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const distEntry = path.join(__dirname, '..', 'dist', 'cli', 'index.js');
const tsEntry = path.join(__dirname, '..', 'src', 'cli', 'index.ts');

function loadCli() {
  if (fs.existsSync(distEntry)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(distEntry);
  }
  if (fs.existsSync(tsEntry)) {
    // Dev fallback — users never hit this in a published install.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('ts-node/register/transpile-only');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require(tsEntry);
    } catch (err) {
      process.stderr.write(
        '[coderover-mcp] dist/ not found and ts-node is unavailable.\n' +
          '  Run `npm run build` in packages/mcp first, or install ts-node for dev.\n',
      );
      process.exit(2);
    }
  }
  process.stderr.write(
    '[coderover-mcp] dist/ not found. Run `npm run build` in packages/mcp first.\n',
  );
  process.exit(2);
}

const cli = loadCli();

const argv = process.argv.slice(2);
cli
  .runCli(argv, {
    out: process.stdout,
    err: process.stderr,
    env: process.env,
    cwd: process.cwd(),
  })
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(`[coderover-mcp] fatal: ${msg}\n`);
    process.exit(1);
  });
