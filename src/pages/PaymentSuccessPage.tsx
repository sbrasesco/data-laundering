import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';

export function PaymentSuccessPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [countdown, setCountdown] = useState(5);

  const paymentId = searchParams.get('payment_id');
  const status = searchParams.get('status');

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(timer);
          navigate('/dashboard');
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [navigate]);

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-4">
      {/* Logo */}
      <div className="mb-8">
        <Link to="/" className="text-2xl font-black text-[#22C365]">
          DataLand
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
        <p className="text-gray-500 mb-6">
          Tu pago fue procesado correctamente. Los créditos serán acreditados en tu cuenta en instantes.
        </p>

        {paymentId && (
          <div className="bg-gray-50 rounded-lg px-4 py-3 mb-6 text-left">
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">ID de pago</p>
            <p className="text-sm font-mono text-gray-700 break-all">{paymentId}</p>
          </div>
        )}

        <p className="text-sm text-gray-400 mb-6">
          Redirigiendo al dashboard en <span className="font-bold text-[#22C365]">{countdown}</span> segundos...
        </p>

        <Link
          to="/dashboard"
          className="block w-full bg-[#22C365] hover:bg-[#1aad55] text-white font-bold py-3 rounded-xl transition-colors"
        >
          Ir al dashboard ahora
        </Link>
      </div>
    </div>
  );
}
