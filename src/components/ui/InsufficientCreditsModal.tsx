import { useState, useCallback, useEffect } from 'react';
import {
  Dialog, DialogContent, DialogHeader,
  DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';

const INTEGRATION_TO_FEATURE: Record<string, string> = {
  google_drive:     'integration_drive',
  ftp:              'integration_ftp',
  sftp:             'integration_sftp',
  firebase_storage: 'integration_firebase',
};

const FEATURE_LABELS: Record<string, string> = {
  integration_drive:    'Drive',
  integration_ftp:      'FTP',
  integration_sftp:     'SFTP',
  integration_firebase: 'Firebase',
};

const PLANES = [
  { nombre: 'Básico',      slug: 'basico',      creditos: '200 créditos',   precio: 'USD 60',  accent: '#22C365' },
  { nombre: 'Profesional', slug: 'profesional', creditos: '600 créditos',   precio: 'USD 162', accent: '#A347D1', badge: 'Popular' },
  { nombre: 'Business',    slug: 'business',    creditos: '1.000 créditos', precio: 'USD 220', accent: '#000000' },
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

interface ActiveFeature {
  key: string;
  multiplierPremium: number;
}

export function InsufficientCreditsModal({ isOpen, onClose }: Props) {
  const { user, organizationId } = useAuth();
  const [loadingSlug, setLoadingSlug] = useState<string | null>(null);
  const [customCredits, setCustomCredits] = useState(50);
  const [loadingCustom, setLoadingCustom] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tiers, setTiers] = useState<PriceTier[]>([]);
  const [activeFeatures, setActiveFeatures] = useState<ActiveFeature[]>([]);

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

    if (!organizationId) return;
    supabase
      .from('tenant_integrations')
      .select('integration_type')
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .then(async ({ data: integrations }) => {
        if (!integrations?.length) return;
        const featureKeys = integrations
          .map(i => INTEGRATION_TO_FEATURE[i.integration_type])
          .filter(Boolean);
        if (!featureKeys.length) return;
        const { data: multipliers } = await supabase
          .from('feature_pricing_multipliers')
          .select('feature_key, multiplier')
          .eq('active', true)
          .in('feature_key', featureKeys);
        if (multipliers) {
          setActiveFeatures(multipliers.map(m => ({
            key: m.feature_key,
            multiplierPremium: Number(m.multiplier) - 1.0,
          })));
        }
      });
  }, [isOpen, organizationId]);

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

  const effectiveMultiplier = 1.0 + activeFeatures.reduce((sum, f) => sum + f.multiplierPremium, 0);
  const effectiveDocs = effectiveMultiplier > 1.0 ? Math.floor(customCredits / effectiveMultiplier) : null;
  const effectiveCostPerDoc = pricePerCredit !== null && effectiveMultiplier > 1.0
    ? (pricePerCredit * effectiveMultiplier).toFixed(2)
    : null;

  const formatTierRange = (t: PriceTier) => {
    const max = t.max_credits !== null ? t.max_credits.toLocaleString('es') : '∞';
    return `${t.min_credits.toLocaleString('es')} – ${max}`;
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Sin créditos disponibles</DialogTitle>
          <DialogDescription>
            Elegí un plan o comprá la cantidad exacta que necesitás.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-0 mt-1">

          {/* ── Columna izquierda — acción ─────────────────────────────── */}
          <div className="flex-1 pr-5 space-y-3 min-w-0">

            {/* Planes */}
            <div className="space-y-2">
              {PLANES.map((plan) => (
                <div
                  key={plan.slug}
                  className="flex items-center justify-between rounded-lg border border-border overflow-hidden"
                  style={{ borderLeftColor: plan.accent, borderLeftWidth: '3px' }}
                >
                  <div className="flex items-center gap-3 px-3 py-2.5">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{plan.nombre}</p>
                        {plan.badge && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full text-white" style={{ background: plan.accent }}>
                            {plan.badge}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{plan.creditos} · {plan.precio}</p>
                    </div>
                  </div>
                  <div className="px-3">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleBuy(plan.slug)}
                      disabled={isAnyLoading}
                    >
                      {loadingSlug === plan.slug ? 'Procesando…' : 'Contratar'}
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            {/* Separador */}
            <div className="flex items-center gap-2">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-muted-foreground">o elegí la cantidad</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            {/* Input custom + comprar */}
            <div className="space-y-2">
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
                  cr. = <span className="font-semibold text-foreground">USD {totalPrice}</span>
                  {pricePerCredit !== null && (
                    <span className="ml-1 text-xs text-muted-foreground">({pricePerCredit.toFixed(2)}/cr.)</span>
                  )}
                </span>
                <Button
                  size="sm"
                  onClick={handleBuyCustom}
                  disabled={isAnyLoading || customCredits < CUSTOM_MIN || pricePerCredit === null}
                >
                  {loadingCustom ? 'Procesando…' : 'Comprar'}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Mínimo {CUSTOM_MIN} créditos · 1 crédito = 1 documento</p>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>

          {/* ── Divisor ────────────────────────────────────────────────── */}
          <div className="w-px bg-border mx-1 self-stretch" />

          {/* ── Columna derecha — informativo ──────────────────────────── */}
          <div className="flex-1 pl-5 space-y-3 min-w-0">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Precios por volumen</p>

            {tiers.length > 0 && (
              <div className="rounded-md border border-border overflow-hidden">
                {tiers.map((t) => {
                  const isActive = activeTier?.min_credits === t.min_credits;
                  return (
                    <div
                      key={t.min_credits}
                      className={`flex justify-between items-center px-3 py-1.5 text-xs border-b border-border last:border-0 transition-colors ${
                        isActive ? 'bg-accent font-semibold text-foreground' : 'text-muted-foreground'
                      }`}
                    >
                      <span>{formatTierRange(t)} cr.</span>
                      <span>USD {Number(t.price_per_credit).toFixed(2)}/cr.</span>
                    </div>
                  );
                })}
              </div>
            )}

            {effectiveDocs !== null && effectiveCostPerDoc !== null ? (
              <div className="rounded-md bg-[#FED210]/10 border border-[#FED210]/40 px-3 py-2 space-y-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-medium" style={{ color: '#92400e' }}>Integraciones activas:</span>
                  {activeFeatures.map(f => (
                    <span key={f.key} className="inline-flex items-center rounded-full bg-[#FED210]/30 px-2 py-0.5 text-[11px] font-medium" style={{ color: '#92400e' }}>
                      {FEATURE_LABELS[f.key] ?? f.key} +{(f.multiplierPremium * 100).toFixed(0)}%
                    </span>
                  ))}
                </div>
                <p className="text-xs" style={{ color: '#92400e' }}>
                  {customCredits} cr. → <span className="font-semibold">~{effectiveDocs} docs</span>
                  {' '}· <span className="font-semibold">USD {effectiveCostPerDoc}/doc</span>
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                A mayor volumen, menor precio por crédito.
              </p>
            )}
          </div>

        </div>
      </DialogContent>
    </Dialog>
  );
}
