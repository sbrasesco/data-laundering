import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export function OnboardingPage() {
  const { markOnboardingComplete } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const handleStart = async () => {
    setLoading(true);
    await markOnboardingComplete();
    navigate('/dashboard');
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="w-full max-w-md text-center">

        {/* Ícono */}
        <div className="flex justify-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-foreground flex items-center justify-center">
            <svg className="w-8 h-8 text-background" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l14 9-14 9V3z" />
            </svg>
          </div>
        </div>

        {/* Texto */}
        <h1 className="text-3xl font-bold text-foreground mb-3">
          ¡Todo listo!
        </h1>
        <p className="text-muted-foreground text-base mb-10">
          Tu cuenta está activa y tus créditos están disponibles.<br />
          Podés empezar a procesar documentos ahora mismo.
        </p>

        {/* CTA */}
        <button
          onClick={handleStart}
          disabled={loading}
          className="w-full py-3 px-6 rounded-lg bg-foreground text-background text-sm font-semibold transition-opacity hover:opacity-80 disabled:opacity-50"
        >
          {loading ? 'Cargando...' : 'Ir al dashboard'}
        </button>

      </div>
    </div>
  );
}
