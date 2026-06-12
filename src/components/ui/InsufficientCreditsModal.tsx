import { useState, useCallback, useEffect } from 'react';
import {
  Dialog, DialogContent, DialogHeader,
  DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';

const PLANES = [
  { nombre: 'Básico',      slug: 'basico',      creditos: '200 créditos',   precio: 'USD 60'  },
  { nombre: 'Profesional', slug: 'profesional', creditos: '600 créditos',   precio: 'USD 162', destacado: true },
  { nombre: 'Business',    slug: 'business',    creditos: '1.000 créditos', precio: 'USD 220' },
];

const CUSTOM_MIN = 20;

interface PriceTier {
  min_credits: number;
  max_credits: number | null;
  price_per_credit: number;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function InsufficientCreditsModal({ isOpen, onClose }: Props) {
  const { user } = useAuth();
  const [loadingSlug, setLoadingSlug] = useState<string | null>(null);
  const [customCredits, setCustomCredits] = useState(50);
  const [loadingCustom, setLoadingCustom] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tiers, setTiers] = useState<PriceTier[]>([]);

  const workerGatewayUrl = import.meta.env.VITE_WORKER_GATEWAY_URL ?? 'https://automation.aignition.net/worker';
  const workerApiKey = import.meta.env.VITE_WORKER_API_KEY ?? 'staging-key-2026';

  useEffect(() => {
    if (!isOpen) return;
    supabase
      .from('credit_price_tiers')
      .select('min_credits, max_credits, price_per_credit')
      .eq('active', true)
      .order('min_credits', { ascending: true })
      .then(({ data }) => { if (data) setTiers(data); });
  }, [isOpen]);

  const getActiveTier = (credits: number): PriceTier | null =>
    tiers.find(t => t.min_credits <= credits && (t.max_credits === null || t.max_credits >= credits)) ?? null;

  const activeTier = getActiveTier(customCredits);
  const pricePerCredit = activeTier ? Number(activeTier.price_per_credit) : null;
  const totalPrice = pricePerCredit !== null ? (customCredits * pricePerCredit).toFixed(2) : '—';

  const redirectToCheckout = (data: { init_point: string; sandbox_init_point: string }) => {
    window.location.href = import.meta.env.DEV ? data.sandbox_init_point : data.init_point;
  };

  const handleBuy = useCallback(async (slug: string) => {
    setError(null);
    setLoadingSlug(slug);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const { data: plan, error: planError } = await supabase
        .from('billing_plans')
        .select('id')
        .eq('name', slug)
        .eq('active', true)
        .single();
      if (planError || !plan) { setError('Plan no encontrado. Intentá nuevamente.'); return; }
      const response = await fetch(`${workerGatewayUrl}/api/mp/create-preference`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerApiKey}` },
        body: JSON.stringify({ plan_id: plan.id, user_id: session?.user?.id ?? user?.id }),
      });
      if (!response.ok) { setError('Error al iniciar el pago. Intentá nuevamente.'); return; }
      redirectToCheckout(await response.json());
    } catch {
      setError('Error inesperado. Intentá nuevamente.');
    } finally {
      setLoadingSlug(null);
    }
  }, [user, workerGatewayUrl, workerApiKey]);

  const handleBuyCustom = useCallback(async () => {
    if (customCredits < CUSTOM_MIN || pricePerCredit === null) return;
    setError(null);
    setLoadingCustom(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(`${workerGatewayUrl}/api/mp/create-custom-preference`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerApiKey}` },
        body: JSON.stringify({ credits: customCredits, user_id: session?.user?.id ?? user?.id }),
      });
      if (!response.ok) { setError('Error al iniciar el pago. Intentá nuevamente.'); return; }
      redirectToCheckout(await response.json());
    } catch {
      setError('Error inesperado. Intentá nuevamente.');
    } finally {
      setLoadingCustom(false);
    }
  }, [customCredits, pricePerCredit, user, workerGatewayUrl, workerApiKey]);

  const isAnyLoading = loadingSlug !== null || loadingCustom;

  const formatTierRange = (t: PriceTier) => {
    const max = t.max_credits !== null ? t.max_credits.toLocaleString('es') : '∞';
    return `${t.min_credits.toLocaleString('es')} – ${max}`;
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Sin créditos disponibles</DialogTitle>
          <DialogDescription>
            Necesitás créditos para procesar documentos. Elegí el plan o comprá la cantidad que necesitás.
          </DialogDescription>
        </DialogHeader>

        {/* Planes */}
        <div className="space-y-2 mt-1">
          {PLANES.map((plan) => (
            <div
              key={plan.slug}
              className={`flex items-center justify-between rounded-lg border px-4 py-3 ${
                plan.destacado ? 'border-primary bg-accent' : 'border-border'
              }`}
            >
              <div>
                <p className="text-sm font-medium">{plan.nombre}</p>
                <p className="text-xs text-muted-foreground">{plan.creditos} · {plan.precio}</p>
              </div>
              <Button
                size="sm"
                variant={plan.destacado ? 'default' : 'outline'}
                onClick={() => handleBuy(plan.slug)}
                disabled={isAnyLoading}
              >
                {loadingSlug === plan.slug ? 'Procesando…' : 'Contratar'}
              </Button>
            </div>
          ))}
        </div>

        {/* Créditos sueltos */}
        <div className="border-t border-border pt-3 space-y-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            O comprá la cantidad que necesitás
          </p>

          {/* Tabla de precios por tramo */}
          {tiers.length > 0 && (
            <div className="rounded-md border border-border overflow-hidden">
              {tiers.map((t) => {
                const isActive = activeTier?.min_credits === t.min_credits;
                return (
                  <div
                    key={t.min_credits}
                    className={`flex justify-between items-center px-3 py-1.5 text-xs border-b border-border last:border-0 transition-colors ${
                      isActive ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    <span>{formatTierRange(t)} créditos</span>
                    <span>USD {Number(t.price_per_credit).toFixed(2)}/cr.</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Input + precio en tiempo real */}
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={CUSTOM_MIN}
              step={1}
              value={customCredits}
              onChange={(e) => setCustomCredits(Math.max(CUSTOM_MIN, parseInt(e.target.value, 10) || CUSTOM_MIN))}
              className="flex h-9 w-24 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <span className="text-sm text-muted-foreground flex-1">
              créditos = <span className="font-semibold text-foreground">USD {totalPrice}</span>
              {pricePerCredit !== null && (
                <span className="ml-1 text-xs">({pricePerCredit.toFixed(2)}/cr.)</span>
              )}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={handleBuyCustom}
              disabled={isAnyLoading || customCredits < CUSTOM_MIN || pricePerCredit === null}
            >
              {loadingCustom ? 'Procesando…' : 'Comprar'}
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            Mínimo {CUSTOM_MIN} créditos · 1 crédito = 1 documento
          </p>
        </div>

        {error && <p className="text-sm text-destructive mt-1">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
