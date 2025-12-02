import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

export interface PdfJob {
  id: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  total_documents: number | null;
  processed_documents: number | null;
  failed_documents: number | null;
  has_warnings: boolean | null;
  error_message: string | null;
  created_at: string;
  period_month: number | null;
  period_year: number | null;
  rows_count: number; // cantidad de filas reales (pdf_job_rows) para ese job
  clients: {
    id: string;
    name: string;
  } | null;
}

async function fetchJobsWithRowCounts() {
  // Primero obtenemos los jobs
  const { data: jobsData, error: jobsError } = await supabase
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
      period_month,
      period_year,
      clients ( id, name )
    `)
    .order('created_at', { ascending: false });

  if (jobsError) {
    throw jobsError;
  }

  if (!jobsData || jobsData.length === 0) {
    return [];
  }

  // Obtenemos los conteos de filas para cada job
  const jobIds = jobsData.map(job => job.id);
  
  const { data: rowCountsData, error: countsError } = await supabase
    .from('pdf_job_rows')
    .select('job_id')
    .in('job_id', jobIds);

  if (countsError) {
    throw countsError;
  }

  // Contamos las filas por job_id
  const rowCountsMap = new Map<string, number>();
  if (rowCountsData) {
    rowCountsData.forEach(row => {
      const count = rowCountsMap.get(row.job_id) || 0;
      rowCountsMap.set(row.job_id, count + 1);
    });
  }

  // Combinamos los datos
  return jobsData.map(job => ({
    ...job,
    rows_count: rowCountsMap.get(job.id) || 0,
  }));
}

export function usePdfJobs() {
  const [jobs, setJobs] = useState<PdfJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchJobs() {
      try {
        setLoading(true);
        setError(null);

        const jobsWithCounts = await fetchJobsWithRowCounts();
        setJobs(jobsWithCounts);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error desconocido al cargar procesos');
        setJobs([]);
      } finally {
        setLoading(false);
      }
    }

    fetchJobs();

    // Configurar suscripción de Realtime para pdf_jobs
    const jobsChannel = supabase
      .channel('pdf_jobs_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'pdf_jobs',
        },
        async () => {
          // Cuando hay cambios en pdf_jobs, refrescar los datos
          try {
            const jobsWithCounts = await fetchJobsWithRowCounts();
            setJobs(jobsWithCounts);
          } catch (err) {
            console.error('Error al refrescar jobs:', err);
          }
        }
      )
      .subscribe();

    // Configurar suscripción de Realtime para pdf_job_rows
    // (por si se agregan filas mientras el job está procesando)
    const rowsChannel = supabase
      .channel('pdf_job_rows_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'pdf_job_rows',
        },
        async () => {
          // Cuando hay cambios en pdf_job_rows, refrescar los datos
          try {
            const jobsWithCounts = await fetchJobsWithRowCounts();
            setJobs(jobsWithCounts);
          } catch (err) {
            console.error('Error al refrescar jobs:', err);
          }
        }
      )
      .subscribe();

    // Cleanup: desuscribirse cuando el componente se desmonte
    return () => {
      supabase.removeChannel(jobsChannel);
      supabase.removeChannel(rowsChannel);
    };
  }, []);

  return { jobs, loading, error };
}

