// AppLayout: alias de AppShell para mantener compatibilidad con imports existentes.
import { ReactNode } from 'react';
import { AppShell } from './AppShell';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  return <AppShell>{children}</AppShell>;
}
