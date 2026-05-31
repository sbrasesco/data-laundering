import { ReactNode } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const { signOut, user } = useAuth();
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
            </div>
          </div>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            {user?.email && (
              <span style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem' }}>
                {user.email}
              </span>
            )}
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

