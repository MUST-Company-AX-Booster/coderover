/**
 * @coderover/mcp-typescript public API.
 *
 * Effectively nothing runtime-callable. The reason this package exists
 * is the dependency graph — installing it puts `tree-sitter-typescript`
 * on the resolution path so `@coderover/mcp`'s lazy require finds it.
 */

/** Companion package version, sourced from `package.json`. */
export declare const version: string;
