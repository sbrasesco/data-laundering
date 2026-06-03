import { Navigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { AppLayout } from '../layout/AppLayout';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { session, loading, user, profile } = useAuth();

  if (process.env.NODE_ENV === 'development') {
    console.log('ProtectedRoute state:', { loading, hasSession: !!session, hasUser: !!user, hasProfile: !!profile });
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-background gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted border-t-foreground" />
        <p className="text-sm text-muted-foreground">Verificando autenticación...</p>
      </div>
    );
  }

  if (!session) {
    console.log('No hay sesión, redirigiendo a /login');
    return <Navigate to="/login" replace />;
  }

  return <AppLayout>{children}</AppLayout>;
}
