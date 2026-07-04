import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { THEMES, applyTheme, getStoredTheme } from '@/lib/themes';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { Switch } from '@/components/ui/Switch';

interface PriceFeature {
  key: string;
  label: string;
  cost: number;
}

interface PricePolling {
  interval_minutes: number;
  label: string;
  cost: number;
}

interface PriceBreakdown {
  base_price: number;
  features: PriceFeature[];
  polling: PricePolling | null;
  total_per_doc: number;
}

function SettingsSection({ title, description, children }: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function PriceRow({ label, cost, highlight = false }: { label: string; cost: number; highlight?: boolean }) {
  return (
    <div className={cn(
      'flex items-center justify-between py-2',
      highlight && 'font-semibold'
    )}>
      <span className={cn('text-sm', highlight ? 'text-foreground' : 'text-muted-foreground')}>{label}</span>
      <span className={cn(
        'text-sm font-mono tabular-nums',
        highlight ? 'text-foreground' : 'text-foreground/80'
      )}>
        ${cost.toFixed(4)}<span className="text-xs text-muted-foreground font-sans">/doc</span>
      </span>
    </div>
  );
}

export function SettingsPage() {
  const [activeTheme, setActiveTheme] = useState(getStoredTheme);
  const [breakdown, setBreakdown] = useState<PriceBreakdown | null>(null);
  const [breakdownLoading, setBreakdownLoading] = useState(true);
  const [lineItemsOn, setLineItemsOn] = useState(false);
  const [lineItemsSaving, setLineItemsSaving] = useState(false);

  useEffect(() => {
    applyTheme(activeTheme);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function fetchBreakdown() {
      try {
        const { data, error } = await supabase.rpc('get_price_breakdown');
        if (!cancelled && !error && data) {
          setBreakdown(data as PriceBreakdown);
        }
      } catch {
        // silencioso
      } finally {
        if (!cancelled) setBreakdownLoading(false);
      }
    }
    fetchBreakdown();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('tenant_feature_flags').select('line_items_enabled').maybeSingle();
      if (!cancelled) setLineItemsOn(data?.line_items_enabled === true);
    })();
    return () => { cancelled = true; };
  }, []);

  const toggleLineItems = async (value: boolean) => {
    setLineItemsSaving(true);
    const prev = lineItemsOn;
    setLineItemsOn(value);
    const { error } = await supabase.rpc('set_own_line_items', { p_value: value });
    if (error) {
      setLineItemsOn(prev);
    } else {
      const { data } = await supabase.rpc('get_price_breakdown');
      if (data) setBreakdown(data as PriceBreakdown);
    }
    setLineItemsSaving(false);
  };

  const handleThemeSelect = (themeName: string) => {
    applyTheme(themeName);
    setActiveTheme(themeName);
  };

  const hasExtras = breakdown && (breakdown.features.length > 0 || breakdown.polling !== null);

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto space-y-8">

      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">
          <span className="inline-block px-2 py-0.5 rounded-lg" style={{ background: '#22C365', color: '#ffffff' }}>Configuracion</span>
        </h1>
        <p className="text-sm text-muted-foreground">
          Preferencias de apariencia y comportamiento del sistema.
        </p>
      </div>

      {/* Costo por documento */}
      <SettingsSection
        title="Costo por documento"
        description="Composicion del precio segun las integraciones y configuraciones activas de tu cuenta."
      >
        {breakdownLoading ? (
          <div className="space-y-2 animate-pulse">
            <div className="h-4 bg-muted rounded w-3/4" />
            <div className="h-4 bg-muted rounded w-1/2" />
            <div className="h-px bg-border my-2" />
            <div className="h-4 bg-muted rounded w-1/3" />
          </div>
        ) : breakdown ? (
          <div className="divide-y divide-border">
            <PriceRow label="Precio base (plan basico)" cost={breakdown.base_price} />

            {breakdown.features.map(f => (
              <PriceRow key={f.key} label={f.label} cost={f.cost} />
            ))}

            {breakdown.polling && (
              <PriceRow
                label={`Intervalo de escucha - ${breakdown.polling.label}`}
                cost={breakdown.polling.cost}
              />
            )}

            {hasExtras && (
              <div className="pt-1">
                <PriceRow label="Total estimado" cost={breakdown.total_per_doc} highlight />
              </div>
            )}

            {!hasExtras && (
              <p className="pt-2 text-xs text-muted-foreground">
                Sin integraciones activas. El costo base aplica para cargas manuales.
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No se pudo cargar el desglose de precios.</p>
        )}
      </SettingsSection>

      {/* Detalle de productos (feature opcional paga) */}
      <SettingsSection
        title="Detalle de productos"
        description="Extrae el detalle de renglones (producto, cantidad y precio) de cada comprobante y lo incluye en la app y en el archivo de salida. Suma un costo por documento."
      >
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            {lineItemsOn
              ? 'Activado: se cobra el costo adicional por documento y se entrega el detalle.'
              : 'Desactivado: no se cobra ni se entrega el detalle.'}
          </p>
          <Switch checked={lineItemsOn} onChange={toggleLineItems} disabled={lineItemsSaving} />
        </div>
      </SettingsSection>

      {/* Apariencia */}
      <SettingsSection
        title="Apariencia"
        description="Elige el color primario de la interfaz. El cambio se aplica de inmediato."
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {THEMES.map((theme) => (
            <button
              key={theme.name}
              onClick={() => handleThemeSelect(theme.name)}
              className={cn(
                'flex flex-col items-center gap-2.5 p-3 rounded-lg border-2 transition-all text-left',
                activeTheme === theme.name
                  ? 'border-primary bg-accent'
                  : 'border-border hover:border-muted-foreground/30 hover:bg-muted/50'
              )}
            >
              <div className="w-full h-10 rounded-md overflow-hidden flex">
                <div className="w-1/3 h-full bg-foreground" />
                <div className="flex-1 h-full flex flex-col gap-0.5 p-1" style={{ background: theme.previewBg }}>
                  <div className="h-1.5 w-3/4 rounded-full" style={{ background: theme.previewPrimary }} />
                  <div className="h-1.5 w-1/2 rounded-full bg-muted-foreground opacity-30" />
                  <div className="h-1.5 w-2/3 rounded-full" style={{ background: theme.previewPrimary, opacity: 0.5 }} />
                </div>
              </div>

              <div className="flex items-center justify-between w-full">
                <span className="text-xs font-medium">{theme.label}</span>
                {activeTheme === theme.name && (
                  <svg className="w-3.5 h-3.5 text-primary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Proximamente"
        description="Mas opciones de configuracion estaran disponibles aqui."
      >
        <p className="text-sm text-muted-foreground">
          Notificaciones, preferencias de exportacion, configuracion de cuenta y mas.
        </p>
      </SettingsSection>

    </div>
  );
}
