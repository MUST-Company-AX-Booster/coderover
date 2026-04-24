import { useMemo } from 'react';
import { useAuthStore } from '../stores/authStore';

export type UserRole = 'admin' | 'user';

interface RoleAccess {
  role: UserRole;
  isAdmin: boolean;
  isUser: boolean;
  hasAccess: (requiredRole: UserRole) => boolean;
}

export function useRoleAccess(): RoleAccess {
  const user = useAuthStore((s) => s.user);

  return useMemo(() => {
    const role = (user?.role as UserRole) || 'user';
    return {
      role,
      isAdmin: role === 'admin',
      isUser: role === 'user',
      hasAccess: (requiredRole: UserRole) => {
        if (requiredRole === 'user') return true;
        return role === 'admin';
      },
    };
  }, [user?.role]);
}
