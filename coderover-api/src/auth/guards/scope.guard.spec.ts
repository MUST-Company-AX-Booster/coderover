import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ScopeGuard } from './scope.guard';

/**
 * Phase 10 A4 — `@RequiresScope` enforcement. Matching scope passes,
 * missing scope 403s, and (critically) a JWT without any `scope` claim
 * bypasses the gate so legacy full-user tokens still work.
 */
describe('ScopeGuard', () => {
  let guard: ScopeGuard;
  let reflector: Reflector;

  function ctxFor(user: any, required: string[] | undefined): ExecutionContext {
    const request = { user };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(required as unknown as string[]);
    return ctx;
  }

  beforeEach(() => {
    reflector = new Reflector();
    guard = new ScopeGuard(reflector);
  });

  it('passes when no scope metadata is present', () => {
    const ctx = ctxFor({ scope: ['search:read'] }, undefined);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('passes when metadata is an empty array', () => {
    const ctx = ctxFor({ scope: [] }, []);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('passes when the JWT has no scope claim (legacy full-user token)', () => {
    const ctx = ctxFor({ email: 'a@b.co' }, ['search:read']);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('passes when the JWT holds the required scope', () => {
    const ctx = ctxFor({ scope: ['search:read', 'graph:read'] }, ['search:read']);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('403s when the JWT is missing the required scope', () => {
    const ctx = ctxFor({ scope: ['graph:read'] }, ['search:read']);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('403s when only a subset of required scopes is held (AND semantics)', () => {
    const ctx = ctxFor({ scope: ['search:read'] }, ['search:read', 'graph:write']);
    expect(() => guard.canActivate(ctx)).toThrow(/graph:write/);
  });

  it('403s with an empty scope array when any scope is required', () => {
    const ctx = ctxFor({ scope: [] }, ['search:read']);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
