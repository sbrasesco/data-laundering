import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export interface LineItem {
  descripcion: string | null;
  cantidad: number | null;
  precio_unitario: number | null;
  importe: number | null;
  orden: number | null;
}

/**
 * LINE-ITEMS (Fase 3): renglones (producto/cantidad/precio) de un documento.
 * La extracción es SIEMPRE; el flag `tenant_feature_flags.line_items_enabled` gatea la VISUALIZACIÓN.
 * Solo se muestran si el tenant tiene la feature activada. RLS scopea items y flag a la org.
 */
export function useLineItems(rowId?: string | number) {
  const [items, setItems] = useState<LineItem[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // OCs (id 'oc-...') no tienen renglones; ids nulos tampoco.
    if (rowId == null || String(rowId).startsWith('oc-')) {
      setItems([]);
      setEnabled(false);
      return;
    }
    let alive = true;
    (async () => {
      setLoading(true);
      const { data: flag } = await supabase
        .from('tenant_feature_flags')
        .select('line_items_enabled')
        .maybeSingle();
      const on = flag?.line_items_enabled === true;
      if (!alive) return;
      setEnabled(on);
      if (on) {
        const { data } = await supabase
          .from('pdf_job_row_items')
          .select('descripcion,cantidad,precio_unitario,importe,orden')
          .eq('row_id', rowId)
          .order('orden', { ascending: true });
        if (alive && data) setItems(data as LineItem[]);
      } else {
        setItems([]);
      }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [rowId]);

  return { items, enabled, loading };
}
