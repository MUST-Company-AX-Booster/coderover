# @coderover/mcp-typescript

Real TypeScript grammar support for [`@coderover/mcp`](https://www.npmjs.com/package/@coderover/mcp). One install, nothing to configure.

```sh
npm install @coderover/mcp-typescript
```

This pulls in both `@coderover/mcp` (the MCP server + CLI) and `tree-sitter-typescript` (the real TS grammar, including the `tsx` dialect). After install, local-mode indexing parses `.ts` / `.tsx` / `.mts` / `.cts` files with the proper grammar — type annotations, `interface`, `type`, generics, decorators, and JSX all parse cleanly instead of degrading through the JS-fallback grammar.

## Why this matters

Through 0.4.x, local mode used `tree-sitter-javascript` for both JS and TS. That grammar is *TS-tolerant* — it parses many TS files without crashing — but it can't actually understand TS-only constructs. Functions with return types (`function foo(): Promise<T>`), interfaces, type aliases, generics on functions, etc. all wind up under `hasError` nodes, so the chunker drops them and `find_symbol` can't see them.

Concretely, the 0.4.0 evaluation against this fixture:

```ts
export interface User { id: string; }
export async function findUser(id: string): Promise<User | null> { ... }
export function retryOn429<T>(fn: () => Promise<T>): Promise<T> { ... }
```

…showed `find_symbol("User")`, `find_symbol("findUser")`, and `find_symbol("retryOn429")` all returning **0 results**, because the JS grammar gave up on every line with a type annotation.

Installing `@coderover/mcp-typescript` flips `@coderover/mcp` over to the real grammar. Same fixture, after this companion is installed: all three symbols index correctly.

## Why a separate package?

`tree-sitter-typescript` is ~38 MB unpacked — a precompiled native parser (per platform) plus the grammar artifacts for both the `typescript` and `tsx` dialects. Adding 38 MB to every `@coderover/mcp` install would undo the install-bloat win 0.3.0 got from splitting out `@coderover/mcp-offline`. Pure-JS users, remote-mode users, and Python/Go/Java-only users never need TS grammar; only the TS-heavy codebases do.

Splitting it out means:

- **Default `@coderover/mcp` install stays small.** No 38 MB grammar tax for users who don't need it.
- **TS users install one package, get full coverage.** No flags, no env vars — `@coderover/mcp` probes for `tree-sitter-typescript` at boot and prefers it for `.ts` files when present.
- **Per-platform native builds happen at install** of this package, not on every `@coderover/mcp` install.

## What this package exports

Effectively nothing runtime-callable. The purpose is the dependency graph: having `@coderover/mcp-typescript` installed means `tree-sitter-typescript` is on the resolution path, and `@coderover/mcp`'s lazy `require('tree-sitter-typescript')` succeeds.

```js
// If you ever need it:
const { version } = require('@coderover/mcp-typescript');
```

That's the whole surface. Everything you'd actually call lives in `@coderover/mcp`.

## Compatibility

| `@coderover/mcp-typescript` | `@coderover/mcp` | Notes                                                                                              |
| --------------------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| `0.1.x`                     | `^0.5.0`         | First release. 0.5.0 added the loader hook; older `@coderover/mcp` versions can't see this companion. |

## Verifying the wiring

```sh
coderover doctor
```

The doctor command reports `[ts-grammar] @coderover/mcp-typescript detected` when the companion is installed and the loader is using it for `.ts` files. Without the companion, doctor logs `[ts-grammar] tree-sitter-typescript not installed; using JS-grammar fallback (install @coderover/mcp-typescript for full TS coverage).`

## License

MIT — same as `@coderover/mcp`.
