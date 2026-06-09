import { useState, useCallback } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { supabase } from '../lib/supabase';

const C = {
  amarillo: '#FED210',
  verde:    '#22C365',
  lila:     '#A347D1',
  negro:    '#000000',
  blanco:   '#FFFFFF',
  gris:     '#CCCCCC',
  grisSuave:'#F5F5F5',
  grisTexto:'#555555',
};

const STATS = [
  { valor: '98%',  label: 'Precisión' },
  { valor: '75%',  label: 'Reducción de Costos' },
  { valor: '24/7', label: 'Siempre operativo' },
  { valor: '100%', label: 'Seguro y confiable' },
];

const FEATURE_ICONS: Record<string, JSX.Element> = {
  ai: (
    <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
      <rect x="3" y="4" width="18" height="14" rx="2"/>
      <path d="M8 4V2M16 4V2M3 10h18"/>
      <path d="M8 14h.01M12 14h.01M16 14h.01"/>
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
      <path d="M9 11l3 3L22 4"/>
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
    </svg>
  ),
  folder: (
    <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      <path d="M12 11v6M9 14l3-3 3 3"/>
    </svg>
  ),
  csv: (
    <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <path d="M3 9h18M3 15h18M9 3v18"/>
    </svg>
  ),
  send: (
    <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
      <path d="M12 19V5M5 12l7-7 7 7"/>
      <path d="M5 19h14"/>
    </svg>
  ),
  stack: (
    <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
      <path d="M12 2L2 7l10 5 10-5-10-5z"/>
      <path d="M2 12l10 5 10-5"/>
      <path d="M2 17l10 5 10-5"/>
    </svg>
  ),
};

const FEATURES = [
  { color: C.verde,    iconKey: 'ai',     titulo: 'Extracción de datos',       desc: 'Procesá facturas en PDF, JPG o PNG con 98% de precisión. La IA identifica todos los campos fiscales en segundos.' },
  { color: C.amarillo, iconKey: 'check',  titulo: 'Validación automática',    desc: 'Verificá totales, IVA y percepciones. Detecta errores al instante antes de que lleguen a tu contador.' },
  { color: C.lila,     iconKey: 'folder', titulo: 'Integración de carpetas',  desc: 'Conectá Google Drive, FTP o SFTP. El sistema monitorea y procesa automáticamente, 24/7.' },
  { color: C.negro,    iconKey: 'csv',    titulo: 'Exportación CSV',          desc: 'Todos los datos estructurados en un CSV listo para importar en tu sistema contable o ERP.' },
  { color: C.verde,    iconKey: 'send',   titulo: 'Salida automática',        desc: 'Recibí el CSV de resultados directamente en tu carpeta configurada al terminar cada procesamiento.' },
  { color: C.lila,     iconKey: 'stack',  titulo: 'Procesamiento masivo',     desc: 'Subí un ZIP con cientos de facturas y procesalas en paralelo. Sin esperas, sin timeouts.' },
];

const PASOS = [
  { num: '1', color: C.amarillo, colorText: C.negro,  titulo: 'Subís tus comprobantes', desc: 'Arrastrá el archivo o conectá tu carpeta para procesamiento automático.' },
  { num: '2', color: C.verde,    colorText: C.blanco, titulo: 'El software extrae los datos',  desc: 'En segundos, todos los campos quedan extraídos y validados automáticamente.' },
  { num: '3', color: C.lila,     colorText: C.blanco, titulo: 'Revisás y confirmás',     desc: 'Verificá los datos en una interfaz clara y confirmá con un click.' },
  { num: '4', color: C.negro,    colorText: C.blanco, titulo: 'Listo para usar',         desc: 'Tu resultado queda guardado, organizado y listo para exportar o enviar.' },
];

// planSlug matches billing_plans.name in DB
const PLANES = [
  { nombre: 'Gratuito',    slug: 'free',         creditos: '20 créditos',    precio: '$0',       porCredito: null,                 destacado: false, acento: C.gris,     acentoText: '#444',   fondo: C.blanco, ctaLabel: 'Empezar gratis', ctaFondo: C.negro,  ctaTexto: C.blanco, ctaHref: '/login',                    features: ['20 documentos', 'PDF, JPG, PNG', 'Exportación CSV', 'Soporte por email'] },
  { nombre: 'Básico',      slug: 'basico',       creditos: '200 créditos',   precio: 'USD 60',   porCredito: 'USD 0,30 / crédito', destacado: false, acento: C.verde,    acentoText: C.blanco, fondo: C.blanco, ctaLabel: 'Contratar',      ctaFondo: C.verde,  ctaTexto: C.blanco, ctaHref: null,                        features: ['200 documentos', 'PDF, JPG, PNG, ZIP', 'Exportación CSV', 'Soporte por email', 'Créditos acumulativos'] },
  { nombre: 'Profesional', slug: 'profesional',  creditos: '600 créditos',   precio: 'USD 162',  porCredito: 'USD 0,27 / crédito', destacado: true,  acento: C.amarillo, acentoText: C.negro,  fondo: C.negro,  ctaLabel: 'Contratar',      ctaFondo: C.verde,  ctaTexto: C.blanco, ctaHref: null,                        features: ['600 documentos', 'PDF, JPG, PNG, ZIP', 'Google Drive / FTP / SFTP', 'Soporte prioritario', 'Créditos acumulativos'] },
  { nombre: 'Business',    slug: 'business',     creditos: '1.000 créditos', precio: 'USD 220',  porCredito: 'USD 0,22 / crédito', destacado: false, acento: C.lila,     acentoText: C.blanco, fondo: C.blanco, ctaLabel: 'Contratar',      ctaFondo: C.lila,   ctaTexto: C.blanco, ctaHref: null,                        features: ['1.000 documentos', 'Google Drive / FTP / SFTP', 'API access', 'Soporte prioritario', 'Créditos acumulativos'] },
  { nombre: 'Enterprise',  slug: null,           creditos: 'Personalizado',  precio: 'A medida', porCredito: null,                 destacado: false, acento: C.negro,    acentoText: C.blanco, fondo: C.blanco, ctaLabel: 'Contactar',      ctaFondo: C.negro,  ctaTexto: C.blanco, ctaHref: 'mailto:hola@aignition.net', features: ['Volumen a medida', 'Integraciones específicas', 'SLA garantizado', 'Onboarding dedicado'] },
];

const FAQS = [
  { color: C.amarillo, q: '¿Qué es un crédito?',           a: 'Un crédito equivale a un documento procesado. Si subís un ZIP con 50 facturas, se consumen 50 créditos.' },
  { color: C.verde,    q: '¿Los créditos vencen?',          a: 'No se resetean mensualmente. Son acumulativos y solo caducan tras 6 meses de inactividad en la cuenta.' },
  { color: C.lila,     q: '¿Qué formatos acepta?',          a: 'PDF, JPG, PNG y archivos ZIP o RAR con múltiples documentos. También imágenes escaneadas.' },
  { color: C.amarillo, q: '¿Puedo integrar mis carpetas?',  a: 'Sí. Los planes Profesional y superiores incluyen Google Drive, FTP y SFTP. El sistema monitorea y procesa automáticamente.' },
  { color: C.verde,    q: '¿Qué datos extrae exactamente?', a: 'Fecha, tipo de comprobante, código AFIP, punto de venta, proveedor, CUIT, IVA discriminado (21%, 10.5%, 27%), percepciones, totales, moneda, CAE y más. 28 campos.' },
  { color: C.lila,     q: '¿Cómo funciona Enterprise?',     a: 'Para volúmenes altos o necesidades específicas contactanos y armamos un plan a medida con SLA y facturación personalizada.' },
];

function CheckIcon({ color }: { color: string }) {
  return (
    <svg className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

function Navbar() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-white border-b-2" style={{ borderBottomColor: C.verde }}>
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-0.5 font-black text-xl tracking-tight">
          <span style={{ color: C.negro }}>Data</span><span style={{ color: C.verde }}>Land</span>
        </div>
        <div className="flex items-center gap-6">
          <a href="#features" className="text-sm font-semibold hidden sm:block" style={{ color: C.grisTexto }}>Características</a>
          <a href="#precios"  className="text-sm font-semibold hidden sm:block" style={{ color: C.grisTexto }}>Planes</a>
          <a href="#contacto" className="text-sm font-semibold hidden sm:block" style={{ color: C.grisTexto }}>Contacto</a>
          <a href="/login" className="text-sm font-semibold" style={{ color: C.grisTexto }}>Ingresar</a>
          <a href="/login" className="text-sm font-black px-4 py-2 rounded-lg" style={{ background: C.verde, color: C.blanco }}>Empezar Gratis</a>
        </div>
      </div>
    </nav>
  );
}

function Hero() {
  return (
    <section className="pt-36 pb-20 px-6 text-center bg-white">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-5xl lg:text-6xl font-black leading-tight mb-6" style={{ color: C.negro }}>
          Extrae datos de facturas{" "}
          <span className="inline-block px-3 py-1 rounded-xl" style={{ background: C.amarillo, color: C.negro }}>en segundos</span>
        </h1>
        <p className="text-xl max-w-2xl mx-auto mb-10 leading-relaxed font-medium" style={{ color: C.grisTexto }}>
          DataLand utiliza inteligencia artificial avanzada para extraer, validar y analizar
          facturas automáticamente. Ahorrá tiempo, costos, minimiza errores y aumenta la productividad de tu equipo.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center mb-4">
          <a href="/login" className="font-black px-8 py-4 rounded-xl text-base" style={{ background: C.verde, color: C.blanco }}>Probar GRATIS</a>
          <a href="#features" className="font-black px-8 py-4 rounded-xl text-base border-2" style={{ borderColor: C.negro, color: C.negro }}>Ver características</a>
        </div>
        <p className="text-sm font-medium" style={{ color: C.gris }}>No requiere tarjeta de crédito</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-14 max-w-3xl mx-auto">
          {STATS.map((s, i) => {
            const cols = [C.verde, C.amarillo, C.lila, C.negro];
            return (
              <div key={s.label} className="rounded-2xl p-5 text-center" style={{ background: cols[i], color: i === 1 ? C.negro : C.blanco }}>
                <div className="text-3xl font-black mb-1">{s.valor}</div>
                <div className="text-xs font-semibold opacity-80">{s.label}</div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section id="features" className="py-20 px-6" style={{ background: C.grisSuave }}>
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-3xl font-black mb-3" style={{ color: C.negro }}>Funcionalidades que transforman tu negocio</h2>
          <p className="font-medium max-w-xl mx-auto" style={{ color: C.grisTexto }}>Automatización completa del ciclo de vida de tus facturas con tecnología de última generación.</p>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {FEATURES.map((f) => (
            <div key={f.titulo} className="bg-white rounded-2xl p-6 border-2 text-center" style={{ borderColor: f.color }}>
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl mb-4" style={{ background: f.color }}>
                {FEATURE_ICONS[f.iconKey]}
              </div>
              <h3 className="font-black text-base mb-2" style={{ color: C.negro }}>{f.titulo}</h3>
              <p className="text-sm leading-relaxed" style={{ color: C.grisTexto }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ComoFunciona() {
  return (
    <section className="py-20 px-6 bg-white">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-3xl font-black mb-3" style={{ color: C.negro }}>Cómo funciona</h2>
          <p className="font-medium" style={{ color: C.grisTexto }}>Procesamiento inteligente en 4 pasos simples.</p>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {PASOS.map((paso) => (
            <div key={paso.num} className="text-center">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-full font-black text-2xl mb-4" style={{ background: paso.color, color: paso.colorText }}>{paso.num}</div>
              <h3 className="font-black mb-2" style={{ color: C.negro }}>{paso.titulo}</h3>
              <p className="text-sm leading-relaxed" style={{ color: C.grisTexto }}>{paso.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Precios() {
  const navigate = useNavigate();
  const [loadingSlug, setLoadingSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleBuy = useCallback(async (slug: string) => {
    setError(null);
    setLoadingSlug(slug);

    try {
      // Check auth
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        // Not logged in — redirect to login with plan param (TASK-61 will handle inline registration)
        navigate(`/login?plan=${slug}&tab=signup`);
        return;
      }

      // Fetch plan_id from DB by slug
      const { data: plan, error: planError } = await supabase
        .from('billing_plans')
        .select('id')
        .eq('name', slug)
        .eq('active', true)
        .single();

      if (planError || !plan) {
        setError('Plan no encontrado. Intentá nuevamente.');
        return;
      }

      // Call Worker Gateway (MP preference creation moved to DO — Supabase Edge Function blocked by MP PolicyAgent)
      const { data: { session: freshSession } } = await supabase.auth.getSession();
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
            plan_id: plan.id,
            user_id: freshSession?.user?.id,
            organization_id: freshSession?.user?.id, // org_id se resuelve en el gateway
          }),
        }
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data.error ?? 'Error al iniciar el pago. Intentá nuevamente.');
        return;
      }

      const data = await response.json();

      // Use sandbox_init_point in development, init_point in production
      const checkoutUrl = import.meta.env.DEV
        ? data.sandbox_init_point
        : data.init_point;

      window.location.href = checkoutUrl;
    } catch (err) {
      console.error('Payment error:', err);
      setError('Error inesperado. Intentá nuevamente.');
    } finally {
      setLoadingSlug(null);
    }
  }, [navigate]);

  return (
    <section id="precios" className="py-24 px-6" style={{ background: C.grisSuave }}>
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-6">
          <h2 className="text-3xl font-black mb-3" style={{ color: C.negro }}>Planes para cada necesidad</h2>
          <p className="font-medium mb-4" style={{ color: C.grisTexto }}>Comenzá gratis y escalá según crezcas.</p>
          <div className="inline-flex items-center gap-2 text-xs font-bold px-4 py-2 rounded-full" style={{ background: C.lila, color: C.blanco }}>
            Créditos acumulativos — no vencen al mes, solo tras 6 meses sin actividad
          </div>
        </div>

        {error && (
          <div className="max-w-md mx-auto mt-4 mb-2 text-sm text-center text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
            {error}
          </div>
        )}

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4 mt-10">
          {PLANES.map((plan) => {
            const isLoading = loadingSlug === plan.slug;

            return (
              <div key={plan.nombre} className="relative rounded-2xl p-5 flex flex-col border-2 text-center" style={{ background: plan.fondo, borderColor: plan.acento }}>
                {plan.destacado && (
                  <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 text-xs font-black px-3 py-1 rounded-full whitespace-nowrap" style={{ background: C.amarillo, color: C.negro }}>
                    Más popular
                  </div>
                )}
                <div className="inline-block text-xs font-black px-2.5 py-1 rounded-lg mb-3 mx-auto" style={{ background: plan.acento, color: plan.acentoText }}>{plan.nombre}</div>
                <div className="text-xs mb-4" style={{ color: plan.destacado ? C.gris : C.grisTexto }}>{plan.creditos}</div>
                <div className="text-3xl font-black mb-1" style={{ color: plan.destacado ? C.amarillo : C.negro }}>{plan.precio}</div>
                <div className="text-xs mb-5 min-h-[16px]" style={{ color: plan.destacado ? '#888' : C.grisTexto }}>{plan.porCredito ?? ''}</div>
                <ul className="space-y-2 mb-5 flex-1 text-left">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-xs" style={{ color: plan.destacado ? '#CBD5E1' : C.grisTexto }}>
                      <CheckIcon color={plan.acento === C.gris ? '#888' : plan.acento} />
                      {f}
                    </li>
                  ))}
                </ul>

                {/* CTA: paid plans use handleBuy, free uses href, enterprise uses mailto */}
                {plan.slug && plan.ctaHref === null ? (
                  <button
                    onClick={() => handleBuy(plan.slug!)}
                    disabled={isLoading}
                    className="text-center text-sm font-black py-2.5 rounded-xl block w-full transition-opacity disabled:opacity-60"
                    style={{ background: plan.ctaFondo, color: plan.ctaTexto }}
                  >
                    {isLoading ? 'Procesando...' : plan.ctaLabel}
                  </button>
                ) : (
                  <a
                    href={plan.ctaHref!}
                    className="text-center text-sm font-black py-2.5 rounded-xl block"
                    style={{ background: plan.ctaFondo, color: plan.ctaTexto }}
                  >
                    {plan.ctaLabel}
                  </a>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function FAQ() {
  return (
    <section className="py-20 px-6 bg-white">
      <div className="max-w-3xl mx-auto">
        <h2 className="text-3xl font-black text-center mb-12" style={{ color: C.negro }}>Preguntas frecuentes</h2>
        <div className="space-y-3">
          {FAQS.map((item) => (
            <div key={item.q} className="rounded-xl p-5 border border-l-4" style={{ borderColor: '#EEEEEE', borderLeftColor: item.color }}>
              <h3 className="font-black text-sm mb-2" style={{ color: C.negro }}>{item.q}</h3>
              <p className="text-sm leading-relaxed" style={{ color: C.grisTexto }}>{item.a}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section id="contacto" className="py-24 px-6" style={{ background: C.negro }}>
      <div className="max-w-2xl mx-auto text-center">
        <h2 className="text-4xl font-black mb-4" style={{ color: C.blanco }}>
          Listo para{" "}
          <span style={{ color: C.amarillo }}>automatizar tus facturas</span>
        </h2>
        <p className="text-lg font-medium mb-10" style={{ color: C.gris }}>Empezá gratis hoy. Sin tarjeta de crédito, sin compromisos.</p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <a href="/login" className="font-black px-8 py-4 rounded-xl text-base" style={{ background: C.verde, color: C.blanco }}>Comenzar ahora</a>
          <a href="mailto:hola@aignition.net" className="font-black px-8 py-4 rounded-xl text-base border-2" style={{ borderColor: C.lila, color: C.lila }}>Hablar con ventas</a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="py-12 px-6 bg-white border-t-4" style={{ borderTopColor: C.verde }}>
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-8">
          <div>
            <div className="font-black text-lg mb-2"><span style={{ color: C.negro }}>Data</span><span style={{ color: C.verde }}>Land</span></div>
            <p className="text-sm leading-relaxed" style={{ color: C.grisTexto }}>Automatización inteligente de facturas con tecnología de IA avanzada.</p>
            <p className="text-xs mt-2" style={{ color: C.gris }}>by Aignition</p>
          </div>
          <div>
            <h4 className="font-black text-sm mb-3" style={{ color: C.negro }}>Producto</h4>
            <ul className="space-y-2 text-sm" style={{ color: C.grisTexto }}>
              <li><a href="#features" className="hover:underline">Características</a></li>
              <li><a href="#precios" className="hover:underline">Planes</a></li>
            </ul>
          </div>
          <div>
            <h4 className="font-black text-sm mb-3" style={{ color: C.negro }}>Empresa</h4>
            <ul className="space-y-2 text-sm" style={{ color: C.grisTexto }}>
              <li><a href="#contacto" className="hover:underline">Contacto</a></li>
              <li><a href="/login" className="hover:underline">Soporte</a></li>
            </ul>
          </div>
          <div>
            <h4 className="font-black text-sm mb-3" style={{ color: C.negro }}>Legal</h4>
            <ul className="space-y-2 text-sm" style={{ color: C.grisTexto }}>
              <li><a href="#" className="hover:underline">Privacidad</a></li>
              <li><a href="#" className="hover:underline">Términos</a></li>
            </ul>
          </div>
        </div>
        <div className="border-t pt-6 flex flex-col sm:flex-row justify-between items-center gap-3" style={{ borderColor: '#EEEEEE' }}>
          <p className="text-xs font-medium" style={{ color: C.gris }}>© {new Date().getFullYear()} Aignition. Todos los derechos reservados.</p>
          <div className="flex gap-6 text-xs font-medium" style={{ color: C.grisTexto }}>
            <a href="#" className="hover:underline">Privacidad</a>
            <a href="#" className="hover:underline">Términos</a>
          </div>
        </div>
      </div>
    </footer>
  );
}

export function LandingPage() {
  const { session, loading } = useAuth();
  if (loading) return null;
  if (session) return <Navigate to="/dashboard" replace />;
  return (
    <div className="min-h-screen bg-white">
      <Navbar />
      <main>
        <Hero />
        <Features />
        <ComoFunciona />
        <Precios />
        <FAQ />
        <CTA />
      </main>
      <Footer />
    </div>
  );
}
