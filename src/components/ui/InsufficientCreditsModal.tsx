import { useState, useCallback } from 'react';
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

const CUSTOM_RATE_USD = 0.30;
const CUSTOM_MIN = 20;

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

  const workerGatewayUrl = import.meta.env.VITE_WORKER_GATEWAY_URL ?? 'https://automation.aignition.net/worker';
  const workerApiKey = import.meta.env.VITE_WORKER_API_KEY ?? 'staging-key-2026';

  const redirectToCheckout = (data: { init_point: string; sandbox_init_point: string }) => {
    const checkoutUrl = import.meta.env.DEV ? data.sandbox_init_point : data.init_point;
    window.location.href = checkoutUrl;
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

      if (planError || !plan) {
        setError('Plan no encontrado. Intentá nuevamente.');
        return;
      }

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
    if (customCredits < CUSTOM_MIN) return;
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
  }, [customCredits, user, workerGatewayUrl, workerApiKey]);

  const isAnyLoading = loadingSlug !== null || loadingCustom;
  const customPrice = (customCredits * CUSTOM_RATE_USD).toFixed(2);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Sin créditos disponibles</DialogTitle>
          <DialogDescription>
            Necesitás créditos para procesar documentos. Elegí el plan que mejor se adapte a tus necesidades.
          </DialogDescription>
        </DialogHeader>

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

        {/* Sección créditos personalizados */}
        <div className="border-t border-border pt-3 space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            O comprá la cantidad que necesitás
          </p>
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
              créditos = <span className="font-medium text-foreground">USD {customPrice}</span>
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={handleBuyCustom}
              disabled={isAnyLoading || customCredits < CUSTOM_MIN}
            >
              {loadingCustom ? 'Procesando…' : 'Comprar'}
            </Button>
          </div>
          {customCredits >= 200 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Tip: el plan Básico incluye 200 créditos por USD 60 — mejor precio por crédito.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Mínimo {CUSTOM_MIN} créditos · USD {CUSTOM_RATE_USD.toFixed(2)}/crédito
          </p>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
