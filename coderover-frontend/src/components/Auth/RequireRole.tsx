import { Navigate } from 'react-router-dom';
import { useRoleAccess, type UserRole } from '../../hooks/useRoleAccess';

interface RequireRoleProps {
  role: UserRole;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export default function RequireRole({ role, children, fallback }: RequireRoleProps) {
  const { hasAccess } = useRoleAccess();

  if (!hasAccess(role)) {
    if (fallback) return <>{fallback}</>;
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}
