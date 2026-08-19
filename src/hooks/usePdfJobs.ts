import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { buildRowCountMaps, ROWS_CLASSIFICATION_SELECT } from '../lib/documentClassification';

export interface PdfJob {
  id: string;
  status: 'pending' | 'processing' | 'done' | 'done_with_warnings' | 'error';
  total_documents: number | null;
  processed_documents: number | null;
  failed_documents: number | null;
  has_warnings: boolean | null;
  has_duplicate: boolean | null;
  low_confidence_documents: number | null;
  corrected_documents: number | null;
  error_message: string | null;
  created_at: string;
  finished_at?: string | null;
  period_month: number | null;
  period_year: number | null;
  input_source: 'frontend_upload' | 'integration_drive' | 'ftp' | 'sftp' | 'firebase_storage' | null;
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

// MISPROCESOS-PAGINATION (2026-08-10): esta vista traia TODOS los jobs de la org y pedia
// los conteos con .in(job_id, [TODOS los ids]) -> con 650 jobs (Menara) la URL superaba el
// limite del proxy (~16 KB) y la pagina moria con "Error desconocido". Ahora pagina en el
// servidor (15 por pagina, patron PERF-DASHBOARD-SCALE) y el .in() lleva <=15 ids siempre.
const PAGE_SIZE = 15;

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  const m = (err as { message?: string } | null)?.message;
  return m || 'Error desconocido al cargar procesos';
}

async function fetchJobsPage(page: number, clientId: string | null): Promise<{ jobs: PdfJob[]; total: number }> {
  const from = (page - 1) * PAGE_SIZE;
  const to   = from + PAGE_SIZE - 1;

  let query = supabase
    .from('pdf_jobs')
    .select(`
      id,
      input_source,
      status,
      total_documents,
      processed_documents,
      failed_documents,
      has_warnings,
      has_duplicate,
      error_message,
      created_at,
      finished_at,
      period_month,
      period_year,
      clients ( id, name )
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (clientId) query = query.eq('client_id', clientId);

  const { data: jobsData, error: jobsError, count } = await query;

  if (jobsError) {
    throw jobsError;
  }

  const total = count ?? 0;

  if (!jobsData || jobsData.length === 0) {
    return { jobs: [], total };
  }

  // Solo los ids de la pagina visible (<=15) -> la URL del .in() no crece con el historico
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

  const jobs = jobsData.map((job) => ({
    ...(job as any),
    rows_count:         rowCountsMap.get(job.id)  || 0,
    ok_rows_count:      okCountsMap.get(job.id)   || 0,
    warning_rows_count: warnCountsMap.get(job.id) || 0,
    failed_rows_count:  failedRowsMap.get(job.id) || 0,
    oc_count:           ocCountsMap.get(job.id)   || 0,
  })) as PdfJob[];

  return { jobs, total };
}

export function usePdfJobs(clientId: string | null = null) {
  const [jobs, setJobs] = useState<PdfJob[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // refs: Realtime/polling refrescan la pagina visible sin re-suscribir canales
  const pageRef = useRef(page);
  pageRef.current = page;
  const clientRef = useRef(clientId);
  clientRef.current = clientId;

  // filtro nuevo -> volver a pagina 1
  useEffect(() => { setPage(1); }, [clientId]);

  const loadJobs = useCallback(async (showSpinner = true) => {
    try {
      if (showSpinner) setLoading(true);
      setError(null);

      const { jobs: pageJobs, total: pageTotal } = await fetchJobsPage(pageRef.current, clientRef.current);
      setJobs(pageJobs);
      setTotal(pageTotal);
    } catch (err) {
      setError(errMessage(err));
      setJobs([]);
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs, page, clientId]);

  // Realtime — NOMBRES DE CANAL INTACTOS (zona cerrada: no duplicar con useClientJobs);
  // el handler refresca la pagina visible con debounce, sin spinner.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refetch = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => loadJobs(false), 350);
    };

    const jobsChannel = supabase
      .channel('mis_procesos_jobs_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pdf_jobs' }, refetch)
      .subscribe();

    const rowsChannel = supabase
      .channel('mis_procesos_rows_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pdf_job_rows' }, refetch)
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(jobsChannel);
      supabase.removeChannel(rowsChannel);
    };
  }, [loadJobs]);

  // Polling mientras haya jobs activos recientes en la pagina visible
  useEffect(() => {
    const FIFTEEN_MIN = 15 * 60 * 1000;
    const now = Date.now();

    const hasActive = jobs.some((job) => {
      const totalDocs = job.total_documents ?? 0;
      const processed = job.processed_documents ?? 0;
      const failed = job.failed_documents ?? 0;

      const stillRunning =
        job.status === 'pending' ||
        job.status === 'processing' ||
        totalDocs === 0 ||
        processed + failed < totalDocs;

      const createdAt = new Date(job.created_at).getTime();
      const isRecent = now - createdAt < FIFTEEN_MIN;

      return stillRunning && isRecent;
    });

    if (!hasActive) return;

    const intervalId = setInterval(() => {
      loadJobs(false);
    }, 5000);

    return () => clearInterval(intervalId);
  }, [jobs, loadJobs]);

  const reload = useCallback(() => {
    loadJobs();
  }, [loadJobs]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return { jobs, total, totalPages, page, setPage, loading, error, reload };
}
