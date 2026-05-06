import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from "vite-tsconfig-paths";
import { traeBadgePlugin } from 'vite-plugin-trae-solo-badge';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Pull version from the repo-root VERSION file so UI kickers never drift
// from the actual shipped version. Falls back to 'dev' if missing.
const APP_VERSION = (() => {
  try {
    return readFileSync(resolve(__dirname, '../VERSION'), 'utf8').trim();
  } catch {
    return 'dev';
  }
})();

/**
 * Marketing-landing dir-index plugin.
 *
 * `public/landing/index.html` is the static marketing page. Vite's dev
 * server doesn't auto-serve `index.html` for directory paths in `public/`
 * — `GET /landing/` falls through to the SPA fallback and React Router's
 * catch-all takes over, which (combined with our anon-redirect logic)
 * creates an infinite reload loop.
 *
 * This middleware rewrites `/landing` and `/landing/` to
 * `/landing/index.html` *before* the SPA fallback runs, so the pretty
 * URL works in dev. For production the static-host (nginx / Cloudflare
 * Pages / etc.) needs equivalent dir-index handling — usually on by
 * default.
 */
const landingIndexFallback = () => ({
  name: 'landing-index-fallback',
  configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, _res: unknown, next: () => void) => void) => void } }) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/landing' || req.url === '/landing/') {
        req.url = '/landing/index.html';
      }
      next();
    });
  },
});

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  build: {
    sourcemap: 'hidden',
  },
  plugins: [
    landingIndexFallback(),
    react({
      babel: {
        plugins: [
          'react-dev-locator',
        ],
      },
    }),
    traeBadgePlugin({
      variant: 'dark',
      position: 'bottom-right',
      prodOnly: true,
      clickable: true,
      clickUrl: 'https://www.trae.ai/solo?showJoin=1',
      autoTheme: true,
      autoThemeTarget: '#root'
    }),
    tsconfigPaths()
  ],
})
