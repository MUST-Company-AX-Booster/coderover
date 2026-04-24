/**
 * Single source of truth for the package version.
 *
 * Reads `package.json` lazily on first call and caches the result. Used by
 * the server's `serverInfo.version` and by `LocalTransport`'s backend
 * version string so neither has to hardcode a constant that drifts every
 * publish.
 *
 * Path resolution: this file sits at `src/version.ts` (compiled to
 * `dist/version.js`). In both layouts, `../package.json` resolves to the
 * package root. We deliberately avoid `require('../package.json')` so the
 * TS compiler doesn't try to type-check or copy the JSON into `dist/`.
 */
import * as fs from 'fs';
import * as path from 'path';

let cached: string | undefined;

/**
 * Returns the version string from the bundled `package.json`, or
 * `'0.0.0-unknown'` if it can't be read (defensive — should never happen
 * in a properly packed install). Cached after first successful read.
 */
export function getPackageVersion(): string {
  if (cached !== undefined) return cached;
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      cached = parsed.version;
      return cached;
    }
  } catch {
    /* fall through to fallback */
  }
  cached = '0.0.0-unknown';
  return cached;
}
