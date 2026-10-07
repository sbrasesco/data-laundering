import { useEffect, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import auroraLogo from '@/assets/aurora-logo.svg';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { useTenantCredits } from '@/hooks/useTenantCredits';
import { usd } from '@/lib/purchaseFormat';
import { pantallaDeVuelta } from '@/lib/purchaseCheckout';

// Vuelta de Mercado Pago (BILLING-COMPRA-5.8).
// Antes: saltaba sola al panel a los 5 segundos; si la sesión no estaba en ese navegador
// (pago desde el celular o la app de MP), el usuario caía en el login sin entender por qué.
// Ahora: no salta sola, espera a ver el saldo acreditado y ofrece un botón según el caso.
const INTERVALO_MS = 3000;
const ESPERA_MAX_MS = 60000;
const VUELTA_SEGUNDOS = 3;

interface PagoLeido {
  status: string;
  credits_accrued: boolean;
  credited_usd: number | null;
}

export function PaymentSuccessPage() {
  const [searchParams] = useSearchParams();
  const { session, loading: authLoading } = useAuth();
  const { balance } = useTenantCredits();

  // external_reference es NUESTRO id de pago; payment_id es el número de operación de Mercado Pago.
  const paymentId = searchParams.get('external_reference');
  const mpPaymentId = searchParams.get('payment_id') ?? searchParams.get('collection_id');

  // La pantalla desde donde se disparó la compra (se consume una sola vez).
  const [destino] = useState(() => pantallaDeVuelta());
  const [pago, setPago] = useState<PagoLeido | null>(null);
  const [demorado, setDemorado] = useState(false);
  const [cuenta, setCuenta] = useState(VUELTA_SEGUNDOS);
  const inicioRef = useRef<number>(Date.now());

  useEffect(() => {
    if (authLoading || !session || !paymentId) return;
    let vivo = true;

    const leer = async () => {
      const { data, error } = await supabase
        .from('payments')
        .select('status, credits_accrued, credited_usd')
        .eq('id', paymentId)
        .maybeSingle();
      if (!vivo) return;
      if (!error && data) {
        setPago({
          status: String(data.status),
          credits_accrued: Boolean(data.credits_accrued),
          credited_usd: data.credited_usd === null ? null : Number(data.credited_usd),
        });
        if (data.credits_accrued) return true;
      }
      if (Date.now() - inicioRef.current > ESPERA_MAX_MS) {
        setDemorado(true);
        return true;
      }
      return false;
    };

    let timer: ReturnType<typeof setTimeout>;
    const ciclo = async () => {
      const listo = await leer();
      if (!vivo || listo) return;
      timer = setTimeout(ciclo, INTERVALO_MS);
    };
    ciclo();

    return () => { vivo = false; clearTimeout(timer); };
  }, [authLoading, session, paymentId]);

  const acreditado = pago?.credits_accrued === true;

  // Acreditado y con sesión: vuelve solo a la pantalla de origen, recargándola
  // (así el saldo y todo lo demás llegan frescos). Sin sesión no vuelve a ningún lado.
  useEffect(() => {
    if (!acreditado || !session) return;
    const tic = setInterval(() => setCuenta(c => Math.max(0, c - 1)), 1000);
    const salto = setTimeout(() => window.location.assign(destino), VUELTA_SEGUNDOS * 1000);
    return () => { clearInterval(tic); clearTimeout(salto); };
  }, [acreditado, session, destino]);

  const enRevision = pago?.status === 'review';

  let mensaje: string;
  if (!session && !authLoading) {
    mensaje = 'Tu pago fue procesado correctamente. Iniciá sesión para ver el saldo en tu cuenta.';
  } else if (acreditado) {
    mensaje = pago?.credited_usd
      ? `Se acreditaron ${usd(pago.credited_usd)} en tu cuenta.`
      : 'El saldo ya está acreditado en tu cuenta.';
  } else if (enRevision) {
    mensaje = 'Estamos revisando este pago antes de acreditarlo. Si en unos minutos no ves el saldo, escribinos.';
  } else if (demorado) {
    mensaje = 'Tu pago está confirmado. La acreditación puede demorar unos minutos y se hace sola: no tenés que hacer nada.';
  } else {
    mensaje = 'Tu pago fue procesado correctamente. Estamos acreditando el saldo, suele tardar unos segundos.';
  }

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-4">
      {/* Logo */}
      <div className="mb-8">
        <Link to="/">
          <img src={auroraLogo} alt="Agora" className="h-9 w-auto" />
        </Link>
      </div>

      {/* Card */}
      <div className="bg-white border-2 border-[#22C365] rounded-2xl p-10 max-w-md w-full text-center shadow-lg">
        {/* Icon */}
        <div className="flex items-center justify-center w-20 h-20 bg-[#22C365] rounded-full mx-auto mb-6">
          <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        </div>

        <h1 className="text-3xl font-black text-black mb-2">¡Pago exitoso!</h1>
        <p className="text-gray-500 mb-6">{mensaje}</p>

        {session && acreditado && balance !== null && (
          <div className="bg-[#22C365]/10 rounded-lg px-4 py-3 mb-6">
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Tu saldo</p>
            <p className="text-2xl font-black text-black">{usd(balance)}</p>
          </div>
        )}

        {session && acreditado && (
          <p className="text-sm text-gray-400 mb-6">
            Te llevamos de vuelta en <span className="font-bold text-[#22C365]">{cuenta}</span>...
          </p>
        )}

        {session && !acreditado && !demorado && !enRevision && (
          <div className="flex items-center justify-center gap-2 mb-6 text-sm text-gray-400">
            <span className="h-4 w-4 rounded-full border-2 border-gray-200 border-t-[#22C365] animate-spin" />
            Acreditando tu saldo...
          </div>
        )}

        {mpPaymentId && (
          <div className="bg-gray-50 rounded-lg px-4 py-3 mb-6 text-left">
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Operación de Mercado Pago</p>
            <p className="text-sm font-mono text-gray-700 break-all">{mpPaymentId}</p>
          </div>
        )}

        {session ? (
          <Link
            to={destino}
            className="block w-full bg-[#22C365] hover:bg-[#1aad55] text-white font-bold py-3 rounded-xl transition-colors"
          >
            {acreditado ? 'Continuar ahora' : 'Continuar'}
          </Link>
        ) : (
          <Link
            to="/login"
            className="block w-full bg-[#22C365] hover:bg-[#1aad55] text-white font-bold py-3 rounded-xl transition-colors"
          >
            Iniciar sesión
          </Link>
        )}
      </div>
    </div>
  );
}
