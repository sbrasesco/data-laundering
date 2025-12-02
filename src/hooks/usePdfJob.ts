import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

export interface PdfJobDetail {
  id: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  total_documents: number | null;
  processed_documents: number | null;
  failed_documents: number | null;
  has_warnings: boolean | null;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
  period_month: number | null;
  period_year: number | null;
  rows_count: number; // cantidad de filas reales (pdf_job_rows) para ese job
  clients: {
    id: string;
    name: string;
  } | null;
}

export function usePdfJob(jobId: string) {
  const [job, setJob] = useState<PdfJobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchJob() {
      if (!jobId) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);

        const { data, error: fetchError } = await supabase
          .from('pdf_jobs')
          .select(`
            id,
            status,
            total_documents,
            processed_documents,
            failed_documents,
            has_warnings,
            error_message,
            created_at,
            finished_at,
            period_month,
            period_year,
            clients ( id, name )
          `)
          .eq('id', jobId)
          .single();

        if (fetchError) {
          setError(fetchError.message);
          setJob(null);
        } else {
          // Obtener el conteo de filas para este job
          const { count, error: countError } = await supabase
            .from('pdf_job_rows')
            .select('*', { count: 'exact', head: true })
            .eq('job_id', jobId);

          const rowsCount = countError ? 0 : (count || 0);

          setJob({
            ...data,
            rows_count: rowsCount,
          });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error desconocido al cargar el proceso');
        setJob(null);
      } finally {
        setLoading(false);
      }
    }

    fetchJob();
  }, [jobId]);

  return { job, loading, error };
}

