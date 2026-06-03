import { useState, FormEvent, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { supabase } from '../lib/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type TabType = 'login' | 'signup';

export function LoginPage() {
  const [activeTab, setActiveTab] = useState<TabType>('login');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [organizationName, setOrganizationName] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');

  const { signInWithPassword, session, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!authLoading && session) navigate('/dashboard', { replace: true });
  }, [session, authLoading, navigate]);

  useEffect(() => {
    setError(null);
    setSuccessMessage(null);
  }, [activeTab]);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await signInWithPassword(email, password);
    if (error) { setError(error.message); setLoading(false); }
    else navigate('/dashboard');
  };

  const handleSignUp = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    if (!organizationName.trim()) { setError('El nombre de la organización es obligatorio'); setLoading(false); return; }
    if (!signupEmail.trim()) { setError('El email es obligatorio'); setLoading(false); return; }
    if (!signupPassword) { setError('La contraseña es obligatoria'); setLoading(false); return; }
    if (signupPassword !== passwordConfirm) { setError('Las contraseñas no coinciden'); setLoading(false); return; }
    if (signupPassword.length < 6) { setError('La contraseña debe tener al menos 6 caracteres'); setLoading(false); return; }

    try {
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({ email: signupEmail.trim(), password: signupPassword });
      if (signUpError) throw new Error(signUpError.message);
      const user = signUpData.user;
      if (!user) throw new Error('El registro fue exitoso, pero no se obtuvo el usuario.');

      const { error: signInError } = await supabase.auth.signInWithPassword({ email: signupEmail.trim(), password: signupPassword });

      if (signInError) {
        const msg = signInError.message?.toLowerCase() || '';
        if (msg.includes('email not confirmed') || msg.includes('email_not_confirmed') || msg.includes('confirm') || signInError.status === 400) {
          setSuccessMessage(`Se ha enviado un correo a ${signupEmail.trim()}. Por favor, confirmá tu registro.`);
          setOrganizationName(''); setSignupEmail(''); setSignupPassword(''); setPasswordConfirm('');
          setLoading(false);
          return;
        }
        throw new Error(signInError.message || 'No se pudo iniciar sesión automáticamente.');
      }

      const { data: org, error: orgError } = await supabase.from('organizations').insert({ name: organizationName.trim() }).select().single();
      if (orgError || !org) throw new Error(orgError?.message || 'Error al crear la organización');
      const { error: profileError } = await supabase.from('profiles').insert({ id: user.id, organization_id: org.id });
      if (profileError) throw new Error(profileError.message || 'Error al crear el perfil');

      setSuccessMessage('Cuenta creada con éxito. Redirigiendo...');
      setOrganizationName(''); setSignupEmail(''); setSignupPassword(''); setPasswordConfirm('');
      setLoading(false);
      setTimeout(() => navigate('/dashboard'), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido al crear la cuenta');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/40 px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center pb-4">
          <CardTitle className="text-2xl font-semibold tracking-tight">Data Laundering</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabType)}>
            <TabsList className="w-full mb-6">
              <TabsTrigger value="login" className="flex-1" disabled={loading}>Iniciar sesión</TabsTrigger>
              <TabsTrigger value="signup" className="flex-1" disabled={loading}>Crear cuenta</TabsTrigger>
            </TabsList>

            <TabsContent value="login">
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={loading} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password">Contraseña</Label>
                  <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required disabled={loading} />
                </div>
                {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? 'Ingresando...' : 'Ingresar'}
                </Button>
              </form>
            </TabsContent>

            <TabsContent value="signup">
              <form onSubmit={handleSignUp} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="organizationName">Nombre de la organización <span className="text-destructive">*</span></Label>
                  <Input id="organizationName" type="text" value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} required disabled={loading} placeholder="Ej: Estudio Contable ABC" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="signupEmail">Email <span className="text-destructive">*</span></Label>
                  <Input id="signupEmail" type="email" value={signupEmail} onChange={(e) => setSignupEmail(e.target.value)} required disabled={loading} placeholder="tu@email.com" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="signupPassword">Contraseña <span className="text-destructive">*</span></Label>
                  <Input id="signupPassword" type="password" value={signupPassword} onChange={(e) => setSignupPassword(e.target.value)} required disabled={loading} placeholder="Mínimo 6 caracteres" minLength={6} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="passwordConfirm">Confirmar contraseña <span className="text-destructive">*</span></Label>
                  <Input id="passwordConfirm" type="password" value={passwordConfirm} onChange={(e) => setPasswordConfirm(e.target.value)} required disabled={loading} placeholder="Repetir contraseña" minLength={6} />
                </div>
                {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
                {successMessage && <Alert variant="success"><AlertDescription>{successMessage}</AlertDescription></Alert>}
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? 'Creando cuenta...' : 'Crear cuenta'}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
