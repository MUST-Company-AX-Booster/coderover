import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SCOPES_KEY } from '../../common/decorators/scope.decorator';

/**
 * Phase 10 A4 — Capability-scope gate. Reads `@RequiresScope(...)`
 * metadata and allows the request only if every required scope is
 * present in the JWT's `scope` claim.
 *
 * Key rule: a token with NO `scope` claim (full-user / pre-A4) bypasses
 * the check. That keeps existing sessions and admin UIs working while
 * MCP clients carry narrowly-scoped tokens.
 */
@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context
      .switchToHttp()
      .getRequest<{ user?: { scope?: string[] } }>();
    const scope = request.user?.scope;

    // No scope claim on the token → full-user access. This is intentional
    // and documented. MCP clients always ship a scope claim; if scope is
    // missing we're looking at a legacy full token.
    if (scope === undefined) return true;

    const held = new Set(scope);
    const missing = required.filter((s) => !held.has(s));
    if (missing.length > 0) {
      throw new ForbiddenException(
        `Missing required scope${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
      );
    }
    return true;
  }
}
