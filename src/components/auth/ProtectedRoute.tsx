import { Navigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { AppLayout } from '../layout/AppLayout';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { session, loading, user, profile } = useAuth();

  // Debug: mostrar información en desarrollo
  if (process.env.NODE_ENV === 'development') {
    console.log('ProtectedRoute state:', { loading, hasSession: !!session, hasUser: !!user, hasProfile: !!profile });
  }

  if (loading) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <div className="spinner"></div>
        <div style={{ marginTop: '1rem', fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
          Verificando autenticación...
        </div>
      </div>
    );
  }

  if (!session) {
    console.log('No hay sesión, redirigiendo a /login');
    return <Navigate to="/login" replace />;
  }

  return <AppLayout>{children}</AppLayout>;
}

