import { useSearchParams, Link } from 'react-router-dom';
import auroraLogo from '@/assets/aurora-logo.svg';

export function PaymentFailurePage() {
  const [searchParams] = useSearchParams();
  const status = searchParams.get('status');

  const isPending = status === 'pending';

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-4">
      {/* Logo */}
      <div className="mb-8">
        <Link to="/">
          <img src={auroraLogo} alt="Agora" className="h-9 w-auto" />
        </Link>
      </div>

      {/* Card */}
      <div className={`bg-white border-2 ${isPending ? 'border-[#FED210]' : 'border-red-400'} rounded-2xl p-10 max-w-md w-full text-center shadow-lg`}>
        {/* Icon */}
        <div className={`flex items-center justify-center w-20 h-20 ${isPending ? 'bg-[#FED210]' : 'bg-red-400'} rounded-full mx-auto mb-6`}>
          {isPending ? (
            <svg className="w-10 h-10 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          ) : (
            <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
            </svg>
          )}
        </div>

        <h1 className="text-3xl font-black text-black mb-2">
          {isPending ? 'Pago pendiente' : 'Pago no procesado'}
        </h1>
        <p className="text-gray-500 mb-8">
          {isPending
            ? 'Tu pago está siendo procesado. Te notificaremos cuando se confirme.'
            : 'El pago no pudo completarse. Podés intentarlo de nuevo o elegir otro método.'}
        </p>

        <div className="flex flex-col gap-3">
          <Link
            to="/#planes"
            className="block w-full bg-[#22C365] hover:bg-[#1aad55] text-white font-bold py-3 rounded-xl transition-colors"
          >
            Intentar nuevamente
          </Link>
          <Link
            to="/dashboard"
            className="block w-full border-2 border-gray-200 hover:border-gray-300 text-gray-700 font-bold py-3 rounded-xl transition-colors"
          >
            Ir al dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
