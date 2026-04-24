/// <reference types="vite/client" />

// Injected by vite.config.ts `define`. Reads from repo-root VERSION file
// at build time so UI never drifts from the shipped version.
declare const __APP_VERSION__: string;
