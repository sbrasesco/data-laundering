import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { AppLayout } from '../layout/AppLayout';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

// Layout route: AppShell montado una sola vez, Outlet cambia con la navegación.
// Evita que useTenantCredits y otras suscripciones globales se reinicien en
// cada navegación entre páginas protegidas.
export function ProtectedLayout() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-background gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted border-t-foreground" />
        <p className="text-sm text-muted-foreground">Verificando autenticación...</p>
      </div>
    );
  }

  if (!session) return <Navigate to="/login" replace />;

  return <AppLayout><Outlet /></AppLayout>;
}

// Mantener compatibilidad con cualquier uso puntual de ProtectedRoute con children.
export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-background gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted border-t-foreground" />
        <p className="text-sm text-muted-foreground">Verificando autenticación...</p>
      </div>
    );
  }

  if (!session) return <Navigate to="/login" replace />;

  return <AppLayout>{children}</AppLayout>;
}
