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

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  build: {
    sourcemap: 'hidden',
  },
  plugins: [
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
