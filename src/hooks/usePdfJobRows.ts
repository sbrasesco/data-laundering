import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

export function usePdfJobRows(jobId: string) {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchRows() {
      if (!jobId) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);

        const { data, error: fetchError } = await supabase
          .from('pdf_job_rows')
          .select('*, pdf_job_row_oc(numero_oc, codigo_obra, nombre_adjunto)')
          .eq('job_id', jobId)
          .order('created_at', { ascending: true });

        if (fetchError) {
          setError(fetchError.message);
          setRows([]);
        } else {
          setRows(data || []);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error desconocido al cargar las filas');
        setRows([]);
      } finally {
        setLoading(false);
      }
    }

    fetchRows();
  }, [jobId]);

  return { rows, loading, error };
}
