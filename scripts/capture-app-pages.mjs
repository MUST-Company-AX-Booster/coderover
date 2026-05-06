#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../..');
const playwrightEntry = join(repoRoot, 'coderover-frontend/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(playwrightEntry).href);

const assetsDir = join(repoRoot, 'assets');
const base = process.env.CODEROVER_DEV_URL ?? 'http://localhost:5173';

const browser = await chromium.launch({
  executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell'
});
const ctx = await browser.newContext({
  deviceScaleFactor: 2,
  viewport: { width: 1440, height: 900 },
  colorScheme: 'dark',
});
const page = await ctx.newPage();

// suppress noisy console errors so the script output stays clean
page.on('pageerror', () => {});
page.on('console', msg => { if (msg.type() === 'error') return; });

async function capture(path, name, opts = {}) {
  const url = base + path;
  console.log(`§ ${name}`);
  console.log(`  → ${url}`);
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
  } catch (e) {
    console.log(`  ! navigation timeout, capturing whatever rendered`);
  }
  // belt-and-suspenders: clear any explicit light override and emit the dark
  // root attribute the design system uses to flip palettes.
  await page.evaluate(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.classList.remove('light');
    document.documentElement.classList.add('dark');
    document.documentElement.style.colorScheme = 'dark';
  }).catch(() => {});
  await page.waitForTimeout(opts.settle ?? 800);
  const out = join(assetsDir, `${name}.png`);
  await page.screenshot({ path: out, fullPage: opts.fullPage ?? false });
  console.log(`  ✓ ${name}.png`);
  return out;
}

// public + auth-gated routes — capture whatever each surface renders for an
// unauthenticated session. Empty states are still real app chrome.
await capture('/design-system', 'app-design-system', { settle: 1200, fullPage: true });
await capture('/login', 'app-login', { settle: 800 });
await capture('/register', 'app-register', { settle: 800 });

// these routes are protected; visiting them when logged-out captures the
// real auth gate / loading state. Useful as truth-of-shipped-UI evidence.
await capture('/dashboard', 'app-dashboard', { settle: 1200 });
await capture('/graph', 'app-graph', { settle: 1200 });
await capture('/pr-reviews', 'app-pr-reviews', { settle: 1200 });

await browser.close();
console.log('§ landed');
