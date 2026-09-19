import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase';
import { usd } from '@/lib/purchaseFormat';

/*
 * Editor de la compra de saldo — BILLING-COMPRA-5.3 (2026-09-19).
 * Monto base, veces el monto base y bono de cada paquete, mínimo y máximo del monto libre.
 * Sólo superadmin: la base lo exige en admin_get_pricing, admin_set_pricing_settings y
 * admin_upsert_package. Lo que se guarda cambia la ventana de compra al instante.
 * El dólar se muestra, no se edita (lo trae el servidor del Banco Central en cada compra).
 */

interface PackageRow {
  code: string;
  label: string;
  multiplier: number;
  bonus_pct: number;
}

interface PricingLoaded {
  base_usd: number;
  min_free_usd: number;
  max_free_usd: number;
  packages: PackageRow[];
  fx: { rate: number; fetched_at: string } | null;
}

// Número escrito a mano: acepta coma o punto decimal. NaN si no es un número positivo o cero.
function num(raw: string): number {
  const s = raw.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}
function decimals(raw: string): number {
  const s = raw.trim().replace(',', '.');
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const plain = (n: number) => n.toLocaleString('es-AR', { maximumFractionDigits: 4 });

const inputCls =
  'h-8 rounded-md border border-input bg-background px-2 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

export function PurchasePricingEditor() {
  const [loaded, setLoaded] = useState<PricingLoaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [base, setBase] = useState('');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [pkg, setPkg] = useState<Record<string, { multiplier: string; bonus: string }>>({});

  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const fillForm = (p: PricingLoaded) => {
    setBase(String(p.base_usd));
    setMin(String(p.min_free_usd));
    setMax(String(p.max_free_usd));
    setPkg(Object.fromEntries(p.packages.map((r) => [r.code, { multiplier: String(r.multiplier), bonus: String(r.bonus_pct) }])));
  };

  const load = useCallback(async (): Promise<boolean> => {
    const { data, error } = await supabase.rpc('admin_get_pricing');
    if (error || !data) {
      setLoadError('No se pudo leer la configuración de la compra de saldo.');
      return false;
    }
    const d = data as Record<string, unknown>;
    const s = (d.settings ?? {}) as Record<string, unknown>;
    const pkgs = (Array.isArray(d.packages) ? d.packages : []) as Record<string, unknown>[];
    const curs = (Array.isArray(d.currencies) ? d.currencies : []) as Record<string, unknown>[];
    const ars = curs.find((c) => c.currency === 'ARS');
    const lr = (ars?.last_rate ?? null) as Record<string, unknown> | null;
    const p: PricingLoaded = {
      base_usd: Number(s.base_usd),
      min_free_usd: Number(s.min_free_usd),
      max_free_usd: Number(s.max_free_usd),
      packages: pkgs
        .filter((r) => r.active !== false)
        .map((r) => ({
          code: String(r.code),
          label: String(r.label),
          multiplier: Number(r.multiplier),
          bonus_pct: Number(r.bonus_pct),
        })),
      fx: lr ? { rate: Number(lr.rate_per_usd), fetched_at: String(lr.fetched_at) } : null,
    };
    setLoadError(null);
    setLoaded(p);
    fillForm(p);
    return true;
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loadError) return <p className="text-sm text-destructive">{loadError}</p>;
  if (!loaded) return <div className="h-40 rounded-md bg-muted animate-pulse" />;

  // Lo escrito, leído y controlado
  const vBase = num(base);
  const vMin = num(min);
  const vMax = num(max);
  const errors: string[] = [];
  if (!(vBase > 0) || decimals(base) > 2) errors.push('El monto base tiene que ser mayor que 0, con hasta 2 decimales.');
  if (!(vMin > 0) || decimals(min) > 2) errors.push('El mínimo del monto libre tiene que ser mayor que 0, con hasta 2 decimales.');
  if (!(vMax > 0) || decimals(max) > 2) errors.push('El máximo del monto libre tiene que ser mayor que 0, con hasta 2 decimales.');
  if (vMin > 0 && vMax > 0 && vMax < vMin) errors.push('El máximo del monto libre no puede ser menor que el mínimo.');

  const rows = loaded.packages.map((r) => {
    const f = pkg[r.code] ?? { multiplier: String(r.multiplier), bonus: String(r.bonus_pct) };
    const m = num(f.multiplier);
    const b = num(f.bonus);
    const mOk = m > 0 && decimals(f.multiplier) <= 4;
    const bOk = b >= 0 && b <= 100 && decimals(f.bonus) <= 2;
    if (!mOk) errors.push(`${r.label}: las veces el monto base tienen que ser mayores que 0.`);
    if (!bOk) errors.push(`${r.label}: el bono tiene que estar entre 0 y 100 %.`);
    const amount = vBase > 0 && mOk ? round2(vBase * m) : null;
    const bonusUsd = amount !== null && bOk ? round2((amount * b) / 100) : null;
    return {
      ...r, f, m, b, amount, bonusUsd,
      changed: mOk && bOk && (m !== r.multiplier || b !== r.bonus_pct),
    };
  });

  const settingsChanged = vBase !== loaded.base_usd || vMin !== loaded.min_free_usd || vMax !== loaded.max_free_usd;
  const dirty = settingsChanged || rows.some((r) => r.changed)
    || rows.some((r) => r.f.multiplier.trim() !== String(r.multiplier) || r.f.bonus.trim() !== String(r.bonus_pct));

  const bonusHint = rows
    .filter((r) => r.amount !== null && r.b > 0)
    .sort((a, b) => (a.amount ?? 0) - (b.amount ?? 0))
    .map((r) => `desde ${usd(r.amount ?? 0)} suma ${plain(r.b)} %`)
    .join('; ');

  const save = async () => {
    if (errors.length > 0 || !dirty) return;
    setSaving(true);
    setMsg(null);
    try {
      if (settingsChanged) {
        const { error } = await supabase.rpc('admin_set_pricing_settings', {
          p_base_usd: vBase, p_min_free_usd: vMin, p_max_free_usd: vMax,
        });
        if (error) throw new Error(error.message);
      }
      for (const r of rows.filter((x) => x.changed)) {
        const { error } = await supabase.rpc('admin_upsert_package', {
          p_code: r.code, p_multiplier: r.m, p_bonus_pct: r.b,
        });
        if (error) throw new Error(`${r.label}: ${error.message}`);
      }
      await load();
      setMsg({ ok: true, text: 'Guardado. La ventana de compra ya muestra los valores nuevos.' });
    } catch (e) {
      await load();   // mostrar lo que quedó de verdad en la base
      setMsg({ ok: false, text: `No se pudo guardar todo (${e instanceof Error ? e.message : 'error'}). Lo que ves es lo que quedó guardado.` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Compra de saldo — paquetes y bonos (USD)</p>
      <div className="rounded-md border p-3 space-y-3">

        {/* Monto base y límites del monto libre */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="text-xs text-muted-foreground space-y-1">
            <span className="block">Monto base</span>
            <span className="flex items-center gap-1.5">US$
              <input type="text" inputMode="decimal" className={`${inputCls} w-24`} value={base}
                onChange={(e) => { setBase(e.target.value); setMsg(null); }} disabled={saving} />
            </span>
          </label>
          <label className="text-xs text-muted-foreground space-y-1">
            <span className="block">Monto libre: mínimo</span>
            <span className="flex items-center gap-1.5">US$
              <input type="text" inputMode="decimal" className={`${inputCls} w-24`} value={min}
                onChange={(e) => { setMin(e.target.value); setMsg(null); }} disabled={saving} />
            </span>
          </label>
          <label className="text-xs text-muted-foreground space-y-1">
            <span className="block">Monto libre: máximo</span>
            <span className="flex items-center gap-1.5">US$
              <input type="text" inputMode="decimal" className={`${inputCls} w-24`} value={max}
                onChange={(e) => { setMax(e.target.value); setMsg(null); }} disabled={saving} />
            </span>
          </label>
        </div>

        {/* Paquetes */}
        <div className="rounded-md border overflow-hidden">
          {rows.map((r, i) => (
            <div key={r.code} className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 ${i < rows.length - 1 ? 'border-b' : ''}`}>
              <p className="text-sm font-medium w-24">{r.label}</p>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                veces el monto base
                <input type="text" inputMode="decimal" className={`${inputCls} w-16`} value={r.f.multiplier}
                  onChange={(e) => { setPkg((prev) => ({ ...prev, [r.code]: { ...r.f, multiplier: e.target.value } })); setMsg(null); }}
                  disabled={saving} />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                bono
                <input type="text" inputMode="decimal" className={`${inputCls} w-16`} value={r.f.bonus}
                  onChange={(e) => { setPkg((prev) => ({ ...prev, [r.code]: { ...r.f, bonus: e.target.value } })); setMsg(null); }}
                  disabled={saving} />
                %
              </label>
              <p className="text-xs flex-1 min-w-[12rem] text-right">
                {r.amount !== null && r.bonusUsd !== null ? (
                  <>
                    Paga <span className="font-semibold">{usd(r.amount)}</span> → recibe{' '}
                    <span className="font-semibold">{usd(round2(r.amount + r.bonusUsd))}</span>
                    {r.bonusUsd > 0 ? <span className="text-[#22C365]"> (+ {usd(r.bonusUsd)})</span> : null}
                  </>
                ) : '—'}
              </p>
            </div>
          ))}
        </div>

        <div className="text-xs text-muted-foreground space-y-0.5">
          <p>Monto libre: {bonusHint ? `${bonusHint}; por debajo, sin bono.` : 'sin bono.'}</p>
          {loaded.fx && (
            <p>
              Dólar oficial en uso (Banco Central): $ {loaded.fx.rate.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} por US$ 1,
              traído el {new Date(loaded.fx.fetched_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}.
              Se actualiza solo en cada compra.
            </p>
          )}
        </div>

        {errors.length > 0 && (
          <ul className="text-xs text-destructive list-disc pl-4 space-y-0.5">
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" className="h-8" disabled={!dirty || errors.length > 0 || saving} onClick={save}>
            {saving ? 'Guardando…' : 'Guardar cambios'}
          </Button>
          <Button size="sm" variant="outline" className="h-8" disabled={!dirty || saving}
            onClick={() => { fillForm(loaded); setMsg(null); }}>
            Descartar
          </Button>
          <p className="text-xs text-muted-foreground flex-1 min-w-[14rem]">
            Se aplica al instante en la ventana de compra de todos los clientes. La página pública todavía tiene los precios escritos a mano.
          </p>
        </div>
        {msg && <p className={`text-xs ${msg.ok ? 'text-[#22C365]' : 'text-destructive'}`}>{msg.text}</p>}
      </div>
    </div>
  );
}
