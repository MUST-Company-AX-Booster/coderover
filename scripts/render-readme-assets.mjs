#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { resolve, basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../..');
const playwrightEntry = join(repoRoot, 'coderover-frontend/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(playwrightEntry).href);
const { launchChromium } = await import(pathToFileURL(join(repoRoot, 'scripts/_playwright-launch.mjs')).href);
const assetsDir = join(repoRoot, 'assets');
const landing = join(repoRoot, 'coderover-frontend/public/landing/index.html');

const browser = await launchChromium(chromium);
const ctx = await browser.newContext({ deviceScaleFactor: 2 });
const page = await ctx.newPage();

async function svgToPng(svgPath) {
  const svg = await readFile(svgPath, 'utf8');
  const m = svg.match(/viewBox="([0-9.\s-]+)"/);
  const [, , w, h] = (m ? m[1].split(/\s+/).map(Number) : [0, 0, 1200, 630]);
  await page.setViewportSize({ width: Math.round(w), height: Math.round(h) });
  await page.setContent(
    `<!doctype html><html><head><style>
      html,body{margin:0;padding:0;background:#0A0A0A;}
      svg{display:block;width:${w}px;height:${h}px;}
    </style></head><body>${svg}</body></html>`,
    { waitUntil: 'load' }
  );
  await page.evaluate(() => document.fonts.ready);
  const out = svgPath.replace(/\.svg$/, '.png');
  await page.locator('svg').screenshot({ path: out, omitBackground: false });
  return out;
}

console.log('§ rasterizing svgs');
const svgs = (await readdir(assetsDir)).filter(f => f.endsWith('.svg')).map(f => join(assetsDir, f));
for (const svg of svgs) {
  const out = await svgToPng(svg);
  console.log('  →', basename(out));
}

console.log('§ capturing live landing page');
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto('file://' + landing, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
// If the landing ships a brand-film video, wait until the first frame is
// decoded so the screenshot doesn't catch a black <video>. No-op if no video.
await page.evaluate(() => {
  const v = document.querySelector('video');
  if (!v) return;
  if (v.readyState >= 2) return; // HAVE_CURRENT_DATA — first frame ready
  return new Promise(r => v.addEventListener('loadeddata', r, { once: true }));
});
await page.screenshot({ path: join(assetsDir, 'landing-hero.png'), clip: { x: 0, y: 0, width: 1440, height: 900 } });
console.log('  → landing-hero.png');

await page.screenshot({ path: join(assetsDir, 'landing-fullpage.png'), fullPage: true });
console.log('  → landing-fullpage.png');

await browser.close();
console.log('§ landed');
