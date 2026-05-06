#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../..');
const playwrightEntry = join(repoRoot, 'coderover-frontend/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(playwrightEntry).href);
const { launchChromium } = await import(pathToFileURL(join(repoRoot, 'scripts/_playwright-launch.mjs')).href);

const assetsDir = join(repoRoot, 'assets');
const base = process.env.CODEROVER_DEV_URL ?? 'http://localhost:5173';

const browser = await launchChromium(chromium);
const ctx = await browser.newContext({
  deviceScaleFactor: 2,
  viewport: { width: 1440, height: 900 },
  colorScheme: 'dark',
});
const page = await ctx.newPage();

// suppress noisy console errors so the script output stays clean
page.on('pageerror', () => {});
page.on('console', msg => { if (msg.type() === 'error') return; });

// Wait for the page to be visually settled — fonts loaded, React mounted
// (root has children), and two animation frames committed so the screenshot
// catches the painted layout rather than a half-mounted skeleton. Deterministic
// (no arbitrary timeout) but capped at 5s so a stuck mount never wedges the
// script.
async function waitForSettled(page) {
  await page.evaluate(async () => {
    const cap = new Promise(r => setTimeout(r, 5000));
    const settled = (async () => {
      await document.fonts.ready;
      // SPA: wait until #root has rendered its first subtree.
      const root = document.getElementById('root') || document.body;
      if (root.childElementCount === 0) {
        await new Promise(r => {
          const obs = new MutationObserver(() => {
            if (root.childElementCount > 0) { obs.disconnect(); r(); }
          });
          obs.observe(root, { childList: true, subtree: true });
          // Already complete? resolve right away — observer wouldn't fire.
          if (document.readyState === 'complete' && root.childElementCount > 0) {
            obs.disconnect();
            r();
          }
        });
      }
      // Two rAFs guarantee a render+paint commit has happened.
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    })();
    await Promise.race([settled, cap]);
  });
}

async function capture(path, name, opts = {}) {
  const url = base + path;
  console.log(`§ ${name}`);
  console.log(`  → ${url}`);
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
  } catch (e) {
    console.log(`  ! navigation timeout, capturing whatever rendered`);
  }
  // Belt-and-suspenders: clear any explicit light override and emit the dark
  // root attribute the design system uses to flip palettes. Some pages set
  // the attribute before mount; this re-asserts our preference.
  await page.evaluate(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.classList.remove('light');
    document.documentElement.classList.add('dark');
    document.documentElement.style.colorScheme = 'dark';
  }).catch(() => {});
  await waitForSettled(page);
  const out = join(assetsDir, `${name}.png`);
  await page.screenshot({ path: out, fullPage: opts.fullPage ?? false });
  console.log(`  ✓ ${name}.png`);
  return out;
}

// Public routes — these render real, brand-locked UI without auth.
// /dashboard, /graph, /pr-reviews etc. redirect to /login when unauthenticated,
// so they're skipped here; capturing them needs an authenticated session.
await capture('/design-system', 'app-design-system', { fullPage: true });
await capture('/login', 'app-login');
await capture('/register', 'app-register');

await browser.close();
console.log('§ landed');
