// Cross-platform Playwright launch helper.
//
// Tries `chromium.launch()` first — the right thing on a contributor machine
// that's run `npx playwright install chromium`. If Playwright complains the
// browser is missing (a version mismatch between the @playwright/test version
// and the cached binaries), it falls back to scanning the local cache for any
// chromium build whose major matches and uses the headless-shell from there.
//
// This way the scripts run unmodified on Linux/Windows/macOS, on first-time
// contributor machines, and on machines where the cache lags behind the npm
// dep version.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

function cacheDir() {
  switch (platform()) {
    case 'darwin': return join(homedir(), 'Library/Caches/ms-playwright');
    case 'win32':  return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'ms-playwright');
    default:       return process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache/ms-playwright');
  }
}

function shellBinaryFor(buildDir) {
  const candidates = [
    'chrome-headless-shell-mac-arm64/chrome-headless-shell',
    'chrome-headless-shell-mac/chrome-headless-shell',
    'chrome-headless-shell-linux/chrome-headless-shell',
    'chrome-headless-shell-win64/chrome-headless-shell.exe',
    'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-linux/chrome',
    'chrome-win/chrome.exe',
  ];
  for (const c of candidates) {
    const p = join(buildDir, c);
    if (existsSync(p)) return p;
  }
  return null;
}

function findCachedChromium() {
  const dir = cacheDir();
  if (!existsSync(dir)) return null;
  const builds = readdirSync(dir)
    .filter(name => /^chromium(_headless_shell)?-\d+$/.test(name))
    .map(name => ({ name, build: parseInt(name.split('-').pop(), 10), path: join(dir, name) }))
    .filter(b => statSync(b.path).isDirectory())
    .sort((a, b) => b.build - a.build); // newest build first

  // Prefer headless_shell when present (smaller, faster) but fall back to full chromium.
  const ordered = [
    ...builds.filter(b => b.name.startsWith('chromium_headless_shell-')),
    ...builds.filter(b => b.name.startsWith('chromium-')),
  ];
  for (const b of ordered) {
    const bin = shellBinaryFor(b.path);
    if (bin) return bin;
  }
  return null;
}

export async function launchChromium(chromium, opts = {}) {
  try {
    return await chromium.launch(opts);
  } catch (err) {
    if (!/Executable doesn't exist/i.test(err?.message ?? '')) throw err;
    const fallback = findCachedChromium();
    if (!fallback) {
      err.message += '\n\nNo cached Chromium build found in ' + cacheDir() +
        '. Run `npx playwright install chromium` and retry.';
      throw err;
    }
    return await chromium.launch({ ...opts, executablePath: fallback });
  }
}
