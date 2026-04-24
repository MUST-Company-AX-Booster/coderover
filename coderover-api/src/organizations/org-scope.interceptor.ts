import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { orgContextStorage, OrgContext } from './org-context';

/**
 * Reads req.user (set by JwtStrategy) and attaches an OrgContext to
 * AsyncLocalStorage for the duration of the request. Services read
 * the active orgId via currentOrgId().
 *
 * Apply globally in main.ts: app.useGlobalInterceptors(new OrgScopeInterceptor()).
 */
@Injectable()
export class OrgScopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const user = req?.user;
    if (!user?.orgId) {
      return next.handle();
    }
    const ctx: OrgContext = {
      userId: user.userId ?? user.sub,
      orgId: user.orgId,
      role: user.role ?? 'user',
    };
    return new Observable(observer => {
      orgContextStorage.run(ctx, () => {
        next.handle().subscribe({
          next: v => observer.next(v),
          error: e => observer.error(e),
          complete: () => observer.complete(),
        });
      });
    });
  }
}
