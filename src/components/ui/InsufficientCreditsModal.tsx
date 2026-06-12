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

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function InsufficientCreditsModal({ isOpen, onClose }: Props) {
  const { user } = useAuth();
  const [loadingSlug, setLoadingSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

      const workerGatewayUrl = import.meta.env.VITE_WORKER_GATEWAY_URL ?? 'https://automation.aignition.net/worker';
      const workerApiKey = import.meta.env.VITE_WORKER_API_KEY ?? 'staging-key-2026';

      const response = await fetch(`${workerGatewayUrl}/api/mp/create-preference`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${workerApiKey}`,
        },
        body: JSON.stringify({
          plan_id: plan.id,
          user_id: session?.user?.id ?? user?.id,
        }),
      });

      if (!response.ok) {
        setError('Error al iniciar el pago. Intentá nuevamente.');
        return;
      }

      const data = await response.json();
      const checkoutUrl = import.meta.env.DEV ? data.sandbox_init_point : data.init_point;
      window.location.href = checkoutUrl;
    } catch {
      setError('Error inesperado. Intentá nuevamente.');
    } finally {
      setLoadingSlug(null);
    }
  }, [user]);

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
                disabled={loadingSlug !== null}
              >
                {loadingSlug === plan.slug ? 'Procesando…' : 'Contratar'}
              </Button>
            </div>
          ))}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
