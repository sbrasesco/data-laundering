import { ReactNode, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useTenantCredits } from '@/hooks/useTenantCredits';
import { cn } from '@/lib/utils';
import { applyTheme, getStoredTheme } from '@/lib/themes';

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface NavItem {
  label: string;
  path: string;
  icon: string;
}

interface AppShellProps {
  children: ReactNode;
}

// ─── Navegación ───────────────────────────────────────────────────────────────

const NAV_MAIN: NavItem[] = [
  { label: 'Dashboard',      path: '/dashboard',    icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
  { label: 'Subir archivos', path: '/jobs/new',      icon: 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12' },
  { label: 'Mis procesos',   path: '/mis-procesos',  icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2' },
  { label: 'Documentos',     path: '/documents',     icon: 'M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z' },
];

const NAV_SYSTEM: NavItem[] = [
  { label: 'Integraciones',  path: '/integrations', icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1' },
  { label: 'Monitoreo',      path: '/monitoring',   icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
  { label: 'Clientes',       path: '/clients',      icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z' },
];

// ─── NavItem ──────────────────────────────────────────────────────────────────

function SidebarNavItem({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      to={item.path}
      className={cn(
        'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
        active
          ? 'bg-accent text-accent-foreground font-medium'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent'
      )}
    >
      <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
      </svg>
      {item.label}
      {active && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-foreground opacity-40" />}
    </Link>
  );
}

// ─── AppShell ─────────────────────────────────────────────────────────────────

export function AppShell({ children }: AppShellProps) {
  const { signOut, user } = useAuth();
  const { balance, loading: creditsLoading } = useTenantCredits();
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + '/');

  // Aplicar tema guardado al montar
  useEffect(() => {
    applyTheme(getStoredTheme());
  }, []);

  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  const initials = (user?.email ?? 'U')
    .split('@')[0]
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="flex h-screen overflow-hidden bg-background">

      {/* ── Sidebar ───────────────────────────────────────────────────────── */}
      <aside className="flex flex-col w-[220px] flex-shrink-0 border-r border-border bg-card overflow-y-auto">

        {/* Logo */}
        <div className="flex items-center gap-2.5 px-4 py-5 border-b border-border">
          <div className="w-7 h-7 rounded-md bg-foreground flex items-center justify-center flex-shrink-0">
            <svg className="w-3.5 h-3.5 text-background" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l14 9-14 9V3z" />
            </svg>
          </div>
          <span className="text-sm font-semibold text-foreground">
            Data Laundering
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-4 space-y-0.5">
          <p className="px-3 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
            Principal
          </p>
          {NAV_MAIN.map((item) => (
            <SidebarNavItem key={item.path} item={item} active={isActive(item.path)} />
          ))}

          <p className="px-3 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider mt-4 mb-1">
            Sistema
          </p>
          {NAV_SYSTEM.map((item) => (
            <SidebarNavItem key={item.path} item={item} active={isActive(item.path)} />
          ))}
        </nav>

        {/* Footer */}
        <div className="px-2 pb-3 pt-3 border-t border-border space-y-1">

          {/* Créditos */}
          <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-muted">
            <svg className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-xs text-muted-foreground">
              {creditsLoading ? '—' : (balance ?? 0).toLocaleString()} créditos
            </span>
          </div>

          {/* Configuración */}
          <Link
            to="/settings"
            className={cn(
              'flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors',
              isActive('/settings')
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            )}
          >
            <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Configuración
          </Link>

          {/* Usuario */}
          <div className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-accent transition-colors group">
            <div className="w-6 h-6 rounded-full bg-foreground flex items-center justify-center text-xs font-semibold text-background flex-shrink-0">
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-foreground truncate">
                {user?.email?.split('@')[0] ?? 'Usuario'}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {user?.email ?? ''}
              </p>
            </div>
            <button
              onClick={handleSignOut}
              title="Cerrar sesión"
              className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors opacity-0 group-hover:opacity-100"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
        </div>
      </aside>

      {/* ── Contenido ─────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-y-auto bg-background">
          {children}
        </main>
      </div>

    </div>
  );
}
