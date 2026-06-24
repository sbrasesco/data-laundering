import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

export interface DocumentType {
  code: string;
  label: string;
}

/**
 * Tipos de documento configurables (tabla `document_types`, config global).
 * El dropdown de edición manual muestra `label` y guarda `code` (el valor canónico
 * que también produce la IA en pdf_job_rows.tipo_documento). Dar de alta un tipo
 * nuevo = INSERT en la tabla, sin redeploy.
 */
export function useDocumentTypes() {
  const [docTypes, setDocTypes] = useState<DocumentType[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error } = await supabase
        .from('document_types')
        .select('code, label')
        .eq('active', true)
        .order('sort_order', { ascending: true });
      if (!active) return;
      if (!error && data) setDocTypes(data as DocumentType[]);
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  return { docTypes, loading };
}
