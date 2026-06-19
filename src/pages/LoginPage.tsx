import { useState, FormEvent, useEffect } from 'react';
import auroraLogo from '@/assets/aurora-logo.svg';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
  const [searchParams] = useSearchParams();
  const planSlug = searchParams.get('plan') ?? '';
  const tabParam = searchParams.get('tab');

  const [activeTab, setActiveTab] = useState<TabType>(tabParam === 'signup' ? 'signup' : 'login');
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

  const handlePostAuth = async () => {
    if (!planSlug) {
      navigate('/dashboard', { replace: true });
      return;
    }

    const freshSession = session;

    if (!freshSession?.access_token) {
      setError('No se pudo obtener la sesión. Intentá nuevamente.');
      return;
    }

    try {
      const { data: planData, error: planError } = await supabase
        .from('billing_plans')
        .select('id')
        .eq('name', planSlug)
        .eq('active', true)
        .single();

      if (planError || !planData) {
        setError('Error al iniciar el pago. Intentá nuevamente.');
        setLoading(false);
        return;
      }

      // Call Worker Gateway (MP preference creation moved to DO — Supabase Edge Function blocked by MP PolicyAgent)
      const workerGatewayUrl = import.meta.env.VITE_WORKER_GATEWAY_URL ?? 'https://automation.aignition.net/worker';
      const workerApiKey = import.meta.env.VITE_WORKER_API_KEY ?? 'staging-key-2026';
      const response = await fetch(
        `${workerGatewayUrl}/api/mp/create-preference`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${workerApiKey}`,
          },
          body: JSON.stringify({
            plan_id: planData.id,
            user_id: freshSession.user.id,
            organization_id: freshSession.user.id, // org_id se resuelve en el gateway
          }),
        }
      );

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        setError(`Error MP: ${errData.detail ?? errData.error ?? response.status}`);
        setLoading(false);
        return;
      }

      const data = await response.json();
      const checkoutUrl = import.meta.env.DEV ? data.sandbox_init_point : data.init_point;

      if (!checkoutUrl) {
        setError('No se pudo obtener la URL de pago. Intentá nuevamente.');
        setLoading(false);
        return;
      }

      window.location.href = checkoutUrl;
    } catch (err) {
      console.error('handlePostAuth error:', err);
      setError('Error inesperado al iniciar el pago. Intentá nuevamente.');
      setLoading(false);
    }
  };

  // !loading is critical: blocks redirect while handleSignUp is still creating org+profile
  useEffect(() => {
    if (!authLoading && !loading && session) handlePostAuth();
  }, [session, authLoading, loading]);

  useEffect(() => {
    setError(null);
    setSuccessMessage(null);
  }, [activeTab]);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await signInWithPassword(email, password);
    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      setLoading(false);
      // useEffect handles redirect via handlePostAuth
    }
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
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email: signupEmail.trim(),
        password: signupPassword,
        options: {
          // El trigger handle_new_user() lee organization_name desde raw_user_meta_data
          // y crea la organización y el profile automáticamente al registrar el usuario.
          data: { organization_name: organizationName.trim() },
        },
      });
      if (signUpError) throw new Error(signUpError.message);
      const user = signUpData.user;
      if (!user) throw new Error('El registro fue exitoso, pero no se obtuvo el usuario.');

      const { error: signInError } = await supabase.auth.signInWithPassword({ email: signupEmail.trim(), password: signupPassword });

      if (signInError) {
        const msg = signInError.message?.toLowerCase() || '';
        if (msg.includes('email not confirmed') || msg.includes('email_not_confirmed') || msg.includes('confirm') || signInError.status === 400) {
          // Guardar nombre de org para crearlo post-confirmación de email
          localStorage.setItem('dl_pending_org', organizationName.trim());
          const confirmMsg = planSlug
            ? `Se ha enviado un correo a ${signupEmail.trim()}. Confirmá tu registro y volvé a la landing para completar tu compra.`
            : `Se ha enviado un correo a ${signupEmail.trim()}. Por favor, confirmá tu registro.`;
          setSuccessMessage(confirmMsg);
          setOrganizationName(''); setSignupEmail(''); setSignupPassword(''); setPasswordConfirm('');
          setLoading(false);
          return;
        }
        throw new Error(signInError.message || 'No se pudo iniciar sesión automáticamente.');
      }

      // La organización y el profile ya fueron creados por el trigger handle_new_user()
      // al momento del signUp — no se necesita crearlos manualmente.

      const successMsg = planSlug ? 'Cuenta creada. Redirigiendo al pago...' : 'Cuenta creada con éxito. Redirigiendo...';
      setSuccessMessage(successMsg);
      setOrganizationName(''); setSignupEmail(''); setSignupPassword(''); setPasswordConfirm('');
      setLoading(false);
      // useEffect handles redirect via handlePostAuth
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido al crear la cuenta');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/40 px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center pb-4">
          {planSlug ? (
            <>
              <CardTitle className="text-2xl font-semibold tracking-tight">
                Contratar plan — {planSlug.charAt(0).toUpperCase() + planSlug.slice(1)}
              </CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                {activeTab === 'signup' ? 'Creá tu cuenta para continuar con el pago' : 'Ingresá para continuar con el pago'}
              </p>
            </>
          ) : (
            <div className="flex justify-center">
              <img src={auroraLogo} alt="Agora" className="h-14 w-auto" />
            </div>
          )}
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
                  {loading ? 'Ingresando...' : planSlug ? 'Ingresar y pagar' : 'Ingresar'}
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
                  {loading ? 'Creando cuenta...' : planSlug ? 'Crear cuenta y pagar' : 'Crear cuenta'}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
