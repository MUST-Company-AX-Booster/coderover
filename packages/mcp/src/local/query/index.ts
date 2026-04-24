/**
 * Phase 11 Wave 3 — public query surface for local-mode MCP.
 *
 * Three tools, one barrel. Callers (the `LocalTransport` in
 * `packages/mcp/src/transport/local-transport.ts`) import everything
 * they need from this module and stay agnostic of the individual
 * file layout.
 */

export * from './types';
export { searchCode } from './search-code';
export type { SearchCodeOptions } from './search-code';
export { findSymbol } from './find-symbol';
export type { FindSymbolOptions } from './find-symbol';
export { findDependencies } from './find-dependencies';
export type { FindDependenciesOptions } from './find-dependencies';
