import { useState, useCallback, useEffect } from 'react';
import {
  Dialog, DialogContent, DialogHeader,
  DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';

interface Plan {
  id: string;
  name: string;
  display_name: string;
  balance_usd: number;
  docs_included: number;
  price_per_doc: number;
}

const PLAN_ACCENTS: Record<string, { color: string; badge?: string }> = {
  basico:      { color: '#22C365' },
  profesional: { color: '#A347D1', badge: 'Popular' },
  business:    { color: '#000000' },
};

const CUSTOM_MIN_USD = 6;   // ~20 docs × $0.30

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function InsufficientCreditsModal({ isOpen, onClose }: Props) {
  const { user, organizationId } = useAuth();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loadingSlug, setLoadingSlug] = useState<string | null>(null);
  const [customAmount, setCustomAmount] = useState<number>(CUSTOM_MIN_USD);
  const [loadingCustom, setLoadingCustom] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workerGatewayUrl = import.meta.env.VITE_WORKER_GATEWAY_URL ?? 'https://automation.aignition.net/worker';
  const workerApiKey = import.meta.env.VITE_WORKER_API_KEY ?? 'staging-key-2026';

  useEffect(() => {
    if (!isOpen) return;
    supabase
      .from('billing_plans')
      .select('id, name, display_name, balance_usd, docs_included, price_per_doc')
      .in('name', ['basico', 'profesional', 'business'])
      .eq('active', true)
      .order('balance_usd', { ascending: true })
      .then(({ data }) => { if (data) setPlans(data as Plan[]); });
  }, [isOpen]);

  const redirectToCheckout = (data: { init_point: string; sandbox_init_point: string }) => {
    window.location.href = import.meta.env.DEV ? data.sandbox_init_point : data.init_point;
  };

  const handleBuyPlan = useCallback(async (plan: Plan) => {
    setError(null);
    setLoadingSlug(plan.name);
    try {
      const { data: { session } } = await supabase.auth.getSession();
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
    if (customAmount < CUSTOM_MIN_USD) return;
    setError(null);
    setLoadingCustom(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(`${workerGatewayUrl}/api/mp/create-custom-preference`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerApiKey}` },
        body: JSON.stringify({ amount_usd: customAmount, user_id: session?.user?.id ?? user?.id }),
      });
      if (!response.ok) { setError('Error al iniciar el pago. Intentá nuevamente.'); return; }
      redirectToCheckout(await response.json());
    } catch {
      setError('Error inesperado. Intentá nuevamente.');
    } finally {
      setLoadingCustom(false);
    }
  }, [customAmount, user, workerGatewayUrl, workerApiKey]);

  const isAnyLoading = loadingSlug !== null || loadingCustom;

  const estDocs = (usd: number) => Math.floor(usd / 0.30);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Sin saldo disponible</DialogTitle>
          <DialogDescription>
            Elegí un plan o depositá el monto que necesitás.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 mt-1">

          {/* Planes */}
          {plans.map((plan) => {
            const accent = PLAN_ACCENTS[plan.name] ?? { color: '#22C365' };
            return (
              <div
                key={plan.name}
                className="flex items-center justify-between rounded-lg border border-border overflow-hidden"
                style={{ borderLeftColor: accent.color, borderLeftWidth: '3px' }}
              >
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{plan.display_name}</p>
                      {accent.badge && (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full text-white" style={{ background: accent.color }}>
                          {accent.badge}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {plan.docs_included.toLocaleString('es')} docs · <span className="font-medium">USD {plan.balance_usd?.toFixed(0) ?? '—'}</span>
                    </p>
                  </div>
                </div>
                <div className="px-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleBuyPlan(plan)}
                    disabled={isAnyLoading}
                  >
                    {loadingSlug === plan.name ? 'Procesando…' : 'Contratar'}
                  </Button>
                </div>
              </div>
            );
          })}

          {/* Separador */}
          <div className="flex items-center gap-2">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs text-muted-foreground">o depositá un monto libre</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          {/* Input custom */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">USD</span>
              <input
                type="number"
                min={CUSTOM_MIN_USD}
                step={1}
                value={customAmount}
                onChange={(e) => setCustomAmount(Math.max(CUSTOM_MIN_USD, parseFloat(e.target.value) || CUSTOM_MIN_USD))}
                className="flex h-9 w-24 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <span className="text-sm text-muted-foreground flex-1">
                ≈ <span className="font-semibold text-foreground">{estDocs(customAmount).toLocaleString('es')}</span> docs
              </span>
              <Button
                size="sm"
                onClick={handleBuyCustom}
                disabled={isAnyLoading || customAmount < CUSTOM_MIN_USD}
              >
                {loadingCustom ? 'Procesando…' : 'Depositar'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Mínimo USD {CUSTOM_MIN_USD} · estimación a $0.30/doc</p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
