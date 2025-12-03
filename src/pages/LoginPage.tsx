import { useState, FormEvent, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { supabase } from '../lib/supabase';

type TabType = 'login' | 'signup';

export function LoginPage() {
  const [activeTab, setActiveTab] = useState<TabType>('login');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Login form state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Signup form state
  const [organizationName, setOrganizationName] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');

  const { signInWithPassword, session, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  // Si el usuario ya está logueado, redirigir a /dashboard
  useEffect(() => {
    if (!authLoading && session) {
      navigate('/dashboard', { replace: true });
    }
  }, [session, authLoading, navigate]);

  // Limpiar errores y mensajes al cambiar de pestaña
  useEffect(() => {
    setError(null);
    setSuccessMessage(null);
  }, [activeTab]);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    const { error } = await signInWithPassword(email, password);

    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      navigate('/dashboard');
    }
  };

  const handleSignUp = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    // Validaciones
    if (!organizationName.trim()) {
      setError('El nombre de la organización es obligatorio');
      setLoading(false);
      return;
    }

    if (!signupEmail.trim()) {
      setError('El email es obligatorio');
      setLoading(false);
      return;
    }

    if (!signupPassword) {
      setError('La contraseña es obligatoria');
      setLoading(false);
      return;
    }

    if (signupPassword !== passwordConfirm) {
      setError('Las contraseñas no coinciden');
      setLoading(false);
      return;
    }

    if (signupPassword.length < 6) {
      setError('La contraseña debe tener al menos 6 caracteres');
      setLoading(false);
      return;
    }

    try {
      // Paso 1: Crear usuario en Supabase Auth
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email: signupEmail.trim(),
        password: signupPassword,
      });

      if (signUpError) {
        throw new Error(signUpError.message);
      }

      const user = signUpData.user;
      if (!user) {
        throw new Error('El registro fue exitoso, pero no se obtuvo el usuario.');
      }

      // Paso 2: IMPORTANTE - Asegurar sesión autenticada
      // Esto es necesario para que RLS use el rol "authenticated" y no "anon"
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: signupEmail.trim(),
        password: signupPassword,
      });

      // Si el error es que el email no está confirmado, mostrar mensaje informativo
      if (signInError) {
        const errorMessage = signInError.message?.toLowerCase() || '';
        if (
          errorMessage.includes('email not confirmed') ||
          errorMessage.includes('email_not_confirmed') ||
          errorMessage.includes('confirm') ||
          signInError.status === 400
        ) {
          // Email requiere confirmación - mostrar mensaje informativo
          setSuccessMessage(
            `Se ha enviado un correo electrónico a ${signupEmail.trim()}. Por favor, confirma tu registro haciendo clic en el enlace que recibiste en tu email.`
          );
          setError(null);
          setLoading(false);

          // Limpiar formulario
          setOrganizationName('');
          setSignupEmail('');
          setSignupPassword('');
          setPasswordConfirm('');

          return; // Salir sin crear organización ni profile
        }

        // Otro tipo de error - lanzar excepción
        throw new Error(
          signInError.message ||
            'No se pudo iniciar sesión automáticamente después del registro.'
        );
      }

      // Paso 3: Crear la organización (ahora con sesión authenticated)
      const { data: org, error: orgError } = await supabase
        .from('organizations')
        .insert({ name: organizationName.trim() })
        .select()
        .single();

      if (orgError || !org) {
        throw new Error(orgError?.message || 'Error al crear la organización');
      }

      // Paso 4: Crear el perfil asociado
      const { error: profileError } = await supabase.from('profiles').insert({
        id: user.id,
        organization_id: org.id,
      });

      if (profileError) {
        throw new Error(profileError.message || 'Error al crear el perfil');
      }

      // Paso 5: Éxito - mostrar mensaje y redirigir
      setSuccessMessage('Cuenta creada con éxito. Redirigiendo...');
      setError(null);
      setLoading(false);

      // Limpiar formulario
      setOrganizationName('');
      setSignupEmail('');
      setSignupPassword('');
      setPasswordConfirm('');

      // Redirigir después de 1-2 segundos
      setTimeout(() => {
        navigate('/dashboard');
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido al crear la cuenta');
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '142.857vh', /* Ajustado para el scale 0.7 */
        width: '100%',
        background: `linear-gradient(to left, var(--color-purple-gradient-end), var(--color-purple-gradient-start))`,
        backgroundAttachment: 'fixed',
        backgroundSize: 'cover',
      }}
    >
      <div className="card" style={{ width: '100%', maxWidth: '500px', margin: '0' }}>
        <h1 style={{ marginBottom: '2rem', textAlign: 'center', color: 'var(--color-text-primary)' }}>
          Data Laundering
        </h1>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '2rem', borderBottom: '2px solid var(--color-border)' }}>
          <button
            type="button"
            onClick={() => setActiveTab('login')}
            disabled={loading}
            style={{
              flex: 1,
              padding: '0.75rem',
              border: 'none',
              background: 'transparent',
              borderBottom: activeTab === 'login' ? '3px solid var(--color-primary)' : '3px solid transparent',
              color: activeTab === 'login' ? 'var(--color-primary)' : 'var(--color-text-secondary)',
              fontWeight: activeTab === 'login' ? '600' : '400',
              cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'all 300ms',
            }}
          >
            Iniciar sesión
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('signup')}
            disabled={loading}
            style={{
              flex: 1,
              padding: '0.75rem',
              border: 'none',
              background: 'transparent',
              borderBottom: activeTab === 'signup' ? '3px solid var(--color-primary)' : '3px solid transparent',
              color: activeTab === 'signup' ? 'var(--color-primary)' : 'var(--color-text-secondary)',
              fontWeight: activeTab === 'signup' ? '600' : '400',
              cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'all 300ms',
            }}
          >
            Crear cuenta
          </button>
        </div>

        {/* Login Form */}
        {activeTab === 'login' && (
          <form onSubmit={handleLogin}>
            <div className="form-group">
              <label htmlFor="email" className="form-label">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={loading}
                className="form-control"
              />
            </div>
            <div className="form-group">
              <label htmlFor="password" className="form-label">
                Contraseña
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={loading}
                className="form-control"
              />
            </div>
            {error && <div className="alert alert-danger">{error}</div>}
            <button
              type="submit"
              disabled={loading}
              className="btn btn-primary"
              style={{ width: '100%' }}
            >
              {loading ? 'Ingresando...' : 'Ingresar'}
            </button>
          </form>
        )}

        {/* Signup Form */}
        {activeTab === 'signup' && (
          <form onSubmit={handleSignUp}>
            <div className="form-group">
              <label htmlFor="organizationName" className="form-label">
                Nombre de la organización <span style={{ color: 'var(--color-primary)' }}>*</span>
              </label>
              <input
                id="organizationName"
                type="text"
                value={organizationName}
                onChange={(e) => setOrganizationName(e.target.value)}
                required
                disabled={loading}
                className="form-control"
                placeholder="Ej: Estudio Contable ABC"
              />
            </div>
            <div className="form-group">
              <label htmlFor="signupEmail" className="form-label">
                Email <span style={{ color: 'var(--color-primary)' }}>*</span>
              </label>
              <input
                id="signupEmail"
                type="email"
                value={signupEmail}
                onChange={(e) => setSignupEmail(e.target.value)}
                required
                disabled={loading}
                className="form-control"
                placeholder="tu@email.com"
              />
            </div>
            <div className="form-group">
              <label htmlFor="signupPassword" className="form-label">
                Contraseña <span style={{ color: 'var(--color-primary)' }}>*</span>
              </label>
              <input
                id="signupPassword"
                type="password"
                value={signupPassword}
                onChange={(e) => setSignupPassword(e.target.value)}
                required
                disabled={loading}
                className="form-control"
                placeholder="Mínimo 6 caracteres"
                minLength={6}
              />
            </div>
            <div className="form-group">
              <label htmlFor="passwordConfirm" className="form-label">
                Confirmar contraseña <span style={{ color: 'var(--color-primary)' }}>*</span>
              </label>
              <input
                id="passwordConfirm"
                type="password"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                required
                disabled={loading}
                className="form-control"
                placeholder="Repetir contraseña"
                minLength={6}
              />
            </div>
            {error && <div className="alert alert-danger">{error}</div>}
            {successMessage && <div className="alert alert-success">{successMessage}</div>}
            <button
              type="submit"
              disabled={loading}
              className="btn btn-success"
              style={{ width: '100%' }}
            >
              {loading ? 'Creando cuenta...' : 'Crear cuenta'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
