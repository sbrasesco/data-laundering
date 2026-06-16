import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function AppHomePage() {
  const { signOut, session } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="p-6 lg:p-8 max-w-2xl mx-auto space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Panel Aurora</h1>
        {session?.user?.email && (
          <p className="text-sm text-muted-foreground">
            Sesión iniciada como: {session.user.email}
          </p>
        )}
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Accesos rápidos</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button onClick={() => navigate('/dashboard')}>Ir al Dashboard</Button>
          <Button variant="outline" onClick={() => navigate('/jobs/new')}>Subir nuevo archivo</Button>
          <Button variant="destructive" onClick={() => signOut()}>Cerrar sesión</Button>
        </CardContent>
      </Card>
    </div>
  );
}
