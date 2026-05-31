import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { buildRowCountMaps, ROWS_CLASSIFICATION_SELECT } from '../lib/documentClassification';

export interface PdfJob {
  id: string;
  status: 'pending' | 'processing' | 'done' | 'done_with_warnings' | 'error';
  total_documents: number | null;
  processed_documents: number | null;
  failed_documents: number | null;
  has_warnings: boolean | null;
  low_confidence_documents: number | null;
  error_message: string | null;
  created_at: string;
  period_month: number | null;
  period_year: number | null;
  // Campos calculados desde pdf_job_rows (usados en vista de detalle / admin)
  rows_count?: number;
  ok_rows_count?: number;
  warning_rows_count?: number;
  failed_rows_count?: number;
  oc_count?: number;
  clients: {
    id: string;
    name: string;
  } | null;
}

async function fetchJobsWithRowCounts(): Promise<PdfJob[]> {
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

  const jobIds = jobsData.map((job) => job.id);

  const { data: rowCountsData, error: countsError } = await supabase
    .from('pdf_job_rows')
    .select(ROWS_CLASSIFICATION_SELECT)
    .in('job_id', jobIds);

  if (countsError) {
    throw countsError;
  }

  const { rowCountsMap, okCountsMap, warnCountsMap, failedRowsMap, ocCountsMap } =
    buildRowCountMaps(rowCountsData || []);

  return jobsData.map((job) => ({
    ...(job as any),
    rows_count:         rowCountsMap.get(job.id)  || 0,
    ok_rows_count:      okCountsMap.get(job.id)   || 0,
    warning_rows_count: warnCountsMap.get(job.id) || 0,
    failed_rows_count:  failedRowsMap.get(job.id) || 0,
    oc_count:           ocCountsMap.get(job.id)   || 0,
  })) as PdfJob[];
}

export function usePdfJobs() {
  const [jobs, setJobs] = useState<PdfJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    loadJobs();

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
          try {
            const jobsWithCounts = await fetchJobsWithRowCounts();
            setJobs(jobsWithCounts);
          } catch (err) {
            console.error('Error al refrescar jobs:', err);
          }
        }
      )
      .subscribe();

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
          try {
            const jobsWithCounts = await fetchJobsWithRowCounts();
            setJobs(jobsWithCounts);
          } catch (err) {
            console.error('Error al refrescar jobs:', err);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(jobsChannel);
      supabase.removeChannel(rowsChannel);
    };
  }, [loadJobs]);

  // Polling mientras haya jobs activos recientes
  useEffect(() => {
    const FIFTEEN_MIN = 15 * 60 * 1000;
    const now = Date.now();

    const hasActive = jobs.some((job) => {
      const total = job.total_documents ?? 0;
      const processed = job.processed_documents ?? 0;
      const failed = job.failed_documents ?? 0;

      const stillRunning =
        job.status === 'pending' ||
        job.status === 'processing' ||
        total === 0 ||
        processed + failed < total;

      const createdAt = new Date(job.created_at).getTime();
      const isRecent = now - createdAt < FIFTEEN_MIN;

      return stillRunning && isRecent;
    });

    if (!hasActive) return;

    const intervalId = setInterval(() => {
      loadJobs();
    }, 5000);

    return () => clearInterval(intervalId);
  }, [jobs, loadJobs]);

  const reload = useCallback(() => {
    loadJobs();
  }, [loadJobs]);

  return { jobs, loading, error, reload };
}
