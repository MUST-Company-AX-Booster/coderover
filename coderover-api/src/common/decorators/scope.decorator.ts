import { SetMetadata } from '@nestjs/common';

export const SCOPES_KEY = 'required_scopes';

/**
 * Phase 10 A4 — Mark an endpoint as requiring one or more capability
 * scopes. Pairs with `ScopeGuard` and the `scope` claim on MCP-issued
 * JWTs.
 *
 * Tokens WITHOUT a `scope` claim (full-user / pre-A4) are allowed through
 * unconditionally — this decorator only gates MCP clients that hold a
 * narrow token. That's the whole point of the scope column: if you're a
 * full user, no scope restriction applies.
 *
 * Usage:
 *   @RequiresScope('search:read')
 *   @Get('/search')
 *   async search() { ... }
 *
 * Multiple scopes = caller must hold all of them (AND semantics). If you
 * need OR, list the scopes on the caller's token and gate on a single
 * one here; OR-gating at the handler is the anti-pattern (silent over-
 * permissioning is how scope systems rot).
 */
export const RequiresScope = (...scopes: string[]) => SetMetadata(SCOPES_KEY, scopes);
