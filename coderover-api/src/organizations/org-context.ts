import { AsyncLocalStorage } from 'async_hooks';

export interface OrgContext {
  userId: string;
  orgId: string;
  role: string;
}

/**
 * AsyncLocalStorage container for the current request's org scope.
 *
 * Services can read the active orgId without drilling it through every
 * method signature. The OrgScopeInterceptor populates this at the
 * request boundary; workers (Bull consumers) populate it explicitly
 * from the job payload.
 */
export const orgContextStorage = new AsyncLocalStorage<OrgContext>();

export function currentOrgId(): string | undefined {
  return orgContextStorage.getStore()?.orgId;
}

export function runWithOrg<T>(ctx: OrgContext, fn: () => T): T {
  return orgContextStorage.run(ctx, fn);
}
