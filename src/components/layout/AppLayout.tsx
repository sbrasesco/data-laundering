import { ReactNode } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useTenantCredits } from '../../hooks/useTenantCredits';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const { signOut, user } = useAuth();
  const { balance, loading: creditsLoading } = useTenantCredits();
  const navigate = useNavigate();
  const location = useLocation();

  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  const isActive = (path: string) => {
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };

  return (
    <div style={{ minHeight: '100vh', backgroundColor: 'var(--color-bg-light)' }}>
      <nav className="navbar">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '96%', margin: '0 auto' }}>
          <div style={{ display: 'flex', gap: '2rem', alignItems: 'center' }}>
            <Link
              to="/dashboard"
              style={{
                textDecoration: 'none',
                fontSize: '1.5rem',
                fontWeight: '700',
                color: 'var(--color-text-primary)',
              }}
            >
              Data Laundering
            </Link>
            <div style={{ display: 'flex', gap: '1rem' }}>
              <Link
                to="/dashboard"
                className={`nav-link ${isActive('/dashboard') ? 'active' : ''}`}
              >
                Dashboard
              </Link>
              <Link
                to="/documents"
                className={`nav-link ${isActive('/documents') ? 'active' : ''}`}
              >
                Documentos
              </Link>
              <Link
                to="/clients"
                className={`nav-link ${isActive('/clients') ? 'active' : ''}`}
              >
                Clientes
              </Link>
              <Link
                to="/monitoring"
                className={`nav-link ${isActive('/monitoring') ? 'active' : ''}`}
              >
                Monitoreo
              </Link>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            {user?.email && (
              <span style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem' }}>
                {user.email}
              </span>
            )}
            <span
              title="Créditos disponibles"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.35rem',
                backgroundColor: 'var(--color-bg-card, #f4f4f5)',
                border: '1px solid var(--color-border, #e4e4e7)',
                borderRadius: '999px',
                padding: '0.3rem 0.75rem',
                fontSize: '0.85rem',
                fontWeight: 600,
                color: 'var(--color-text-primary)',
                minWidth: '5rem',
                justifyContent: 'center',
              }}
            >
              💳 {creditsLoading ? '—' : (balance ?? 0).toLocaleString()} créditos
            </span>
            <button onClick={handleSignOut} className="btn btn-danger" style={{ fontSize: '0.9rem', padding: '0.5rem 1rem' }}>
              Cerrar sesión
            </button>
          </div>
        </div>
      </nav>
      <main className="container" style={{ paddingTop: '1.25rem', paddingBottom: '1.25rem' }}>
        {children}
      </main>
    </div>
  );
}

