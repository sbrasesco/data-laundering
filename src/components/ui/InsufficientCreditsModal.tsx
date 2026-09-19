import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Dialog, DialogContent, DialogHeader,
  DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase';
import { usd, parseAmount } from '@/lib/purchaseFormat';

/*
 * Recargar saldo — BILLING-COMPRA-5.2 (2026-09-19).
 * - Paquetes, mínimo y máximo salen de la base (get_purchase_options). Nada escrito a mano.
 * - Todo se muestra en dólares. El cobro en pesos lo arma el servidor al momento de comprar,
 *   con la cotización oficial del Banco Central, y el cliente lo ve en Mercado Pago antes
 *   de pagar (decisión del director).
 * - El bono del monto libre lo calcula la base (quote_purchase): la misma regla que al cobrar.
 * - Documentos estimados con el costo por documento de este cliente
 *   (get_price_breakdown().total_per_doc), el mismo número de la barra lateral.
 * - Compra por la puerta nueva /api/purchase/create con la sesión del usuario.
 *   Una compra a la vez: los botones quedan bloqueados hasta salir a Mercado Pago.
 */

interface PurchasePackage {
  code: string;
  label: string;
  base_usd: number;
  bonus_pct: number;
  bonus_usd: number;
  credited_usd: number;
}

interface PurchaseOptions {
  min_free_usd: number;
  max_free_usd: number;
  packages: PurchasePackage[];
}

interface FreeQuote {
  amount: number;
  bonus_usd: number;
  credited_usd: number;
}

const PACKAGE_ACCENTS: Record<string, { color: string; badge?: string }> = {
  basico:      { color: '#22C365' },
  profesional: { color: '#A347D1', badge: 'Popular' },
  business:    { color: '#000000' },
};

const GATEWAY_URL = import.meta.env.VITE_WORKER_GATEWAY_URL ?? 'https://api.agoradigital.io';
const SESSION_EXPIRED = 'Tu sesión venció. Volvé a entrar e intentá de nuevo.';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function InsufficientCreditsModal({ isOpen, onClose }: Props) {
  const [options, setOptions] = useState<PurchaseOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [costPerDoc, setCostPerDoc] = useState<number | null>(null);

  const [amountText, setAmountText] = useState('');
  const [showAmountError, setShowAmountError] = useState(false);
  const [freeQuote, setFreeQuote] = useState<FreeQuote | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  // Al abrir: precios desde la base y costo por documento de este cliente.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setOptions(null);
    setLoadError(null);
    setError(null);
    setAmountText('');
    setShowAmountError(false);
    setFreeQuote(null);

    supabase.rpc('get_purchase_options').then(({ data, error: rpcError }) => {
      if (cancelled) return;
      if (rpcError || !data) {
        setLoadError('No pudimos cargar los precios. Cerrá y volvé a intentar.');
        return;
      }
      const d = data as Record<string, unknown>;
      const pkgs = Array.isArray(d.packages) ? (d.packages as Record<string, unknown>[]) : [];
      setOptions({
        min_free_usd: Number(d.min_free_usd),
        max_free_usd: Number(d.max_free_usd),
        packages: pkgs.map((p) => ({
          code:         String(p.code),
          label:        String(p.label),
          base_usd:     Number(p.base_usd),
          bonus_pct:    Number(p.bonus_pct),
          bonus_usd:    Number(p.bonus_usd),
          credited_usd: Number(p.credited_usd),
        })),
      });
    });

    // Best-effort: si falla, no se muestra la estimación de documentos.
    supabase.rpc('get_price_breakdown').then(({ data, error: rpcError }) => {
      if (cancelled || rpcError) return;
      const total = Number((data as { total_per_doc?: number } | null)?.total_per_doc);
      setCostPerDoc(Number.isFinite(total) && total > 0 ? total : null);
    });

    return () => { cancelled = true; };
  }, [isOpen]);

  // Monto libre: se escribe libre; el mínimo y el máximo se controlan al confirmar o al salir del campo.
  const amount = parseAmount(amountText);
  const amountError: string | null = !options ? null
    : amount === null ? 'Escribí un monto.'
    : Number.isNaN(amount) ? 'Escribí un monto válido, con hasta 2 decimales (por ejemplo 25 o 25,50).'
    : amount < options.min_free_usd ? `El mínimo es ${usd(options.min_free_usd)}.`
    : amount > options.max_free_usd ? `El máximo es ${usd(options.max_free_usd)}.`
    : null;
  const validAmount: number | null = options && amountError === null ? amount : null;

  // Bono del monto libre: lo calcula la base, con la misma regla que al cobrar.
  useEffect(() => {
    setFreeQuote(null);
    if (validAmount === null) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      supabase
        .rpc('quote_purchase', { p_currency: 'ARS', p_package_code: null, p_amount_usd: validAmount })
        .then(({ data, error: rpcError }) => {
          if (cancelled || rpcError || !data) return;
          const q = data as Record<string, unknown>;
          setFreeQuote({ amount: validAmount, bonus_usd: Number(q.bonus_usd), credited_usd: Number(q.credited_usd) });
        });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [validAmount]);

  const docsOf = (credited: number): number | null =>
    costPerDoc ? Math.floor(credited / costPerDoc) : null;
  const docsText = (credited: number) => {
    const n = docsOf(credited);
    return n === null ? '' : ` · ≈ ${n.toLocaleString('es-AR')} documentos`;
  };

  const startPurchase = useCallback(async (
    key: string,
    payload: { package_code: string } | { amount_usd: number },
  ) => {
    if (busyRef.current) return;   // una sola compra a la vez, aunque haya doble clic
    busyRef.current = true;
    setBusy(key);
    setError(null);
    let leaving = false;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) { setError(SESSION_EXPIRED); return; }
      const res = await fetch(`${GATEWAY_URL}/api/purchase/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...payload, currency: 'ARS', origin_product: 'agora' }),
      });
      const body = (await res.json().catch(() => null)) as { init_point?: string; error?: string } | null;
      if (res.ok && body?.init_point) {
        leaving = true;
        window.location.href = body.init_point;
        return;
      }
      setError(res.status === 401 ? SESSION_EXPIRED : (body?.error ?? 'No se pudo iniciar el pago. Intentá nuevamente.'));
    } catch {
      setError('No se pudo conectar con el servidor de pagos. Intentá nuevamente.');
    } finally {
      if (!leaving) { busyRef.current = false; setBusy(null); }
    }
  }, []);

  const buyFree = () => {
    setShowAmountError(true);
    if (validAmount === null) return;
    startPurchase('free', { amount_usd: validAmount });
  };

  const isBusy = busy !== null;
  const bonusHint = (options?.packages ?? [])
    .filter((p) => p.bonus_pct > 0)
    .sort((a, b) => a.base_usd - b.base_usd)
    .map((p, i) => `${i === 0 ? 'Desde' : 'desde'} ${usd(p.base_usd)}, ${p.bonus_pct.toLocaleString('es-AR')}% de bono`)
    .join('; ');

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Recargar saldo</DialogTitle>
          <DialogDescription>
            Elegí un paquete o escribí el monto que necesitás. El saldo se suma al que ya tenés.
          </DialogDescription>
        </DialogHeader>

        {loadError ? (
          <p className="text-sm text-destructive">{loadError}</p>
        ) : !options ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" aria-busy="true">
            {[0, 1, 2].map((i) => <div key={i} className="h-40 rounded-lg bg-muted animate-pulse" />)}
          </div>
        ) : (
          <div className="space-y-4">

            {/* Paquetes, uno al lado del otro */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {options.packages.map((pkg) => {
                const accent = PACKAGE_ACCENTS[pkg.code] ?? { color: '#22C365' };
                const key = `pkg:${pkg.code}`;
                const docs = docsOf(pkg.credited_usd);
                return (
                  <div
                    key={pkg.code}
                    className="flex flex-col rounded-lg border border-border overflow-hidden"
                    style={{ borderTopColor: accent.color, borderTopWidth: '3px' }}
                  >
                    <div className="flex-1 px-3 pt-3 pb-2">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{pkg.label}</p>
                        {accent.badge && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full text-white" style={{ background: accent.color }}>
                            {accent.badge}
                          </span>
                        )}
                      </div>
                      <p className="text-xl font-semibold mt-1">{usd(pkg.base_usd)}</p>
                      <p className="text-xs font-medium text-[#22C365] min-h-[16px]">
                        {pkg.bonus_usd > 0 ? `+ ${usd(pkg.bonus_usd)} de bono` : ''}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">Recibís {usd(pkg.credited_usd)} de saldo</p>
                      {docs !== null && (
                        <p className="text-xs text-muted-foreground">≈ {docs.toLocaleString('es-AR')} documentos</p>
                      )}
                    </div>
                    <div className="px-3 pb-3">
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full"
                        onClick={() => startPurchase(key, { package_code: pkg.code })}
                        disabled={isBusy}
                      >
                        {busy === key ? 'Procesando…' : 'Comprar'}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Separador */}
            <div className="flex items-center gap-2">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-muted-foreground">o elegí el monto</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            {/* Monto libre */}
            <form className="space-y-1.5" noValidate onSubmit={(e) => { e.preventDefault(); buyFree(); }}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">US$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    aria-label="Monto en dólares"
                    placeholder={String(options.min_free_usd)}
                    value={amountText}
                    onChange={(e) => { setAmountText(e.target.value); setShowAmountError(false); setError(null); }}
                    onBlur={() => { if (amountText.trim() !== '') setShowAmountError(true); }}
                    disabled={isBusy}
                    className="flex h-9 w-28 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </div>
                <div className="flex-1 min-w-[12rem] text-xs">
                  {showAmountError && amountError ? (
                    <span className="text-destructive">{amountError}</span>
                  ) : freeQuote && freeQuote.amount === validAmount ? (
                    <span className="text-muted-foreground">
                      Recibís <span className="font-semibold text-foreground">{usd(freeQuote.credited_usd)}</span> de saldo
                      {freeQuote.bonus_usd > 0 ? ` (incluye ${usd(freeQuote.bonus_usd)} de bono)` : ''}
                      {docsText(freeQuote.credited_usd)}
                    </span>
                  ) : null}
                </div>
                <Button type="submit" size="sm" disabled={isBusy}>
                  {busy === 'free' ? 'Procesando…' : 'Comprar'}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Mínimo {usd(options.min_free_usd)}, máximo {usd(options.max_free_usd)}.{bonusHint ? ` ${bonusHint}.` : ''}
              </p>
            </form>

            {error && <p className="text-sm text-destructive">{error}</p>}

            {/* Leyenda de la moneda (pedido del director: genérica, válida cuando haya más pasarelas) */}
            <p className="text-xs text-muted-foreground border-t border-border pt-3">
              Los precios están en dólares. Si pagás con Mercado Pago, el monto se convierte a pesos argentinos
              a la cotización oficial del Banco Central, y lo ves antes de confirmar el pago.
              {costPerDoc ? ` Los documentos son una estimación con tu costo actual de ${usd(costPerDoc)} por documento.` : ''}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
