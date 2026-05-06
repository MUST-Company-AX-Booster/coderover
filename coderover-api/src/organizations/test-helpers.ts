import { OrgContext, runWithOrg } from './org-context';

/**
 * Test-only helper: run `fn` inside a synthetic org-scope so services
 * that read `currentOrgId()` see something instead of throwing
 * `ForbiddenException('Organization scope required')`.
 *
 * In production, `OrgScopeInterceptor` populates the AsyncLocalStorage
 * at the request boundary; Bull workers populate it from the job
 * payload. Neither runs in unit tests, so any service method with a
 * `const orgId = currentOrgId(); if (!orgId) throw ...` guard fails
 * fast at the guard. Wrap the test body:
 *
 *   const result = await withTestOrg(() => service.findAll());
 *
 * Defaults to `{ orgId: 'test-org', userId: 'test-user', role: 'admin' }`.
 * Pass `ctx` to override any field.
 *
 * Lives next to `org-context.ts` (the production module) instead of a
 * separate `test-utils/` tree because it's a thin wrapper over
 * `runWithOrg` — discovery via "find it where you'd find the thing
 * it wraps" is the cheapest convention.
 */
export function withTestOrg<T>(
  fn: () => T,
  ctx: Partial<OrgContext> = {},
): T {
  // `runWithOrg` is generic and propagates whatever `fn` returns —
  // sync values, Promises, void, anything. Letting `T` be inferred
  // from `fn`'s return type means a sync body returns a sync value
  // and an async body returns a Promise; no caller has to narrow a
  // `T | Promise<T>` union (which the previous shape forced).
  return runWithOrg(
    {
      orgId: ctx.orgId ?? 'test-org',
      userId: ctx.userId ?? 'test-user',
      role: ctx.role ?? 'admin',
    },
    fn,
  );
}
