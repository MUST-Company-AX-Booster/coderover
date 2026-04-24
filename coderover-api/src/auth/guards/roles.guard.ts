import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../roles.enum';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: { role?: Role; roles?: Role[] } }>();
    const roleList = request.user?.roles ?? (request.user?.role ? [request.user.role] : []);
    const allowed = requiredRoles.some((role) => roleList.includes(role));
    if (!allowed) {
      throw new ForbiddenException('Insufficient role privileges');
    }
    return true;
  }
}
