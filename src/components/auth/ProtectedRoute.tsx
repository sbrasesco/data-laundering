import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { AppLayout } from '../layout/AppLayout';

export function SuperadminRoute() {
  const { isSuperadmin, loading } = useAuth();
  if (loading) return null;
  return isSuperadmin ? <Outlet /> : <Navigate to="/dashboard" replace />;
}

interface ProtectedRouteProps {
  children: React.ReactNode;
}

// Layout route: AppShell montado una sola vez, Outlet cambia con la navegación.
// Evita que useTenantCredits y otras suscripciones globales se reinicien en
// cada navegación entre páginas protegidas.
export function ProtectedLayout() {
  const { session, loading, orgBlocked, signOut } = useAuth();

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-background gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted border-t-foreground" />
        <p className="text-sm text-muted-foreground">Verificando autenticación...</p>
      </div>
    );
  }

  if (!session) return <Navigate to="/login" replace />;

  if (orgBlocked) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-background gap-4 px-4">
        <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
          <svg className="w-6 h-6 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
        </div>
        <div className="text-center space-y-1">
          <h1 className="text-lg font-semibold">Cuenta suspendida</h1>
          <p className="text-sm text-muted-foreground max-w-sm">Tu organización fue desactivada. Contactá al administrador para más información.</p>
        </div>
        <button onClick={() => signOut()} className="text-sm text-muted-foreground hover:text-foreground underline">
          Cerrar sesión
        </button>
      </div>
    );
  }

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
