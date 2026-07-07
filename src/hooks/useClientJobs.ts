import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { PdfJob } from './usePdfJobs';
import { useAuth } from './useAuth';

export interface DashboardFilters {
  clientId?: string;
  fechaDesde?: string;
  fechaHasta?: string;
}

export interface ClientJobsMetrics {
  jobsCount: number;
  totalDocuments: number;
  processedDocuments: number;    // total_documents (facturas + OCs)
  failedDocuments: number;       // docs con campos insuficientes (doc_status = 'failed')
  documentsWithWarnings: number; // docs con datos incompletos (doc_status = 'warning')
  correctedDocuments: number;    // docs corregidos manualmente (aprobados tras error/advertencia)
  jobsWithError: number;
  duplicateDocuments: number;    // documentos detectados como duplicados (is_duplicate / has_duplicate)
  totalExecutionMs: number;      // suma de (finished_at - created_at) de los procesos del tenant
  avgConfidence: number | null;  // % efectividad de extracción (avg confidence_score 0..1) o null
}

const PDF_JOBS_SELECT = `
  id,
  client_id,
  input_source,
  status,
  total_documents,
  processed_documents,
  failed_documents,
  low_confidence_documents,
  corrected_documents,
  has_warnings,
  has_duplicate,
  error_message,
  created_at,
  finished_at,
  period_month,
  period_year,
  clients ( id, name )
`;

// PERF-DASHBOARD-SCALE: métricas por agregado en DB (RPC get_dashboard_metrics, SECURITY INVOKER
// + RLS). Reemplaza el cálculo client-side sobre todas las filas. Respeta los filtros del dashboard.
async function fetchDashboardMetrics(filters?: DashboardFilters): Promise<ClientJobsMetrics | null> {
  try {
    const { data, error } = await supabase.rpc('get_dashboard_metrics', {
      p_client_id:   filters?.clientId   ?? null,
      p_fecha_desde: filters?.fechaDesde ?? null,
      p_fecha_hasta: filters?.fechaHasta ?? null,
    });
    if (error) return null;
    const m: any = Array.isArray(data) ? data[0] : data;
    if (!m) return null;
    return {
      jobsCount:             Number(m.jobs_count) || 0,
      totalDocuments:        Number(m.total_documents) || 0,
      processedDocuments:    Number(m.processed_documents) || 0,
      failedDocuments:       Number(m.failed_documents) || 0,
      documentsWithWarnings: Number(m.documents_with_warnings) || 0,
      correctedDocuments:    Number(m.corrected_documents) || 0,
      jobsWithError:         Number(m.jobs_with_error) || 0,
      duplicateDocuments:    Number(m.duplicate_documents) || 0,
      totalExecutionMs:      Number(m.total_execution_ms) || 0,
      avgConfidence:         m.avg_confidence == null ? null : Number(m.avg_confidence),
    };
  } catch {
    return null;
  }
}

const PAGE_SIZE = 10;

export function useClientJobs(filters?: DashboardFilters) {
  const [jobs, setJobs] = useState<PdfJob[]>([]);
  // initialLoading: true solo en la primera carga (sin datos todavía)
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalJobs, setTotalJobs] = useState(0);
  const [systemAvgConfidence, setSystemAvgConfidence] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<ClientJobsMetrics>({
    jobsCount: 0,
    totalDocuments: 0,
    processedDocuments: 0,
    failedDocuments: 0,
    documentsWithWarnings: 0,
    correctedDocuments: 0,
    jobsWithError: 0,
    duplicateDocuments: 0,
    totalExecutionMs: 0,
    avgConfidence: null,
  });
  const { organizationId, loading: authLoading } = useAuth();
  const subscriptionRef = useRef<any>(null);
  const hasLoadedOnce = useRef(false);
  const metricsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clientId   = filters?.clientId;
  const fechaDesde = filters?.fechaDesde;
  const fechaHasta = filters?.fechaHasta;

  // Reset a la página 1 cuando cambian los filtros (no cuando cambia la página).
  useEffect(() => { setPage(1); }, [clientId, fechaDesde, fechaHasta]);

  // Carga la página actual de procesos (range + count). Usada por: inicial, cambio de página/filtros,
  // Realtime (refetch debounced de la página actual) y polling de respaldo. PERF-DASHBOARD-SCALE:
  // ya NO trae todos los procesos del tenant — solo la página visible. Las métricas van por RPC.
  const loadPage = useCallback(async () => {
    if (!organizationId) return;
    try {
      let query = supabase.from('pdf_jobs').select(PDF_JOBS_SELECT, { count: 'exact' });
      if (clientId)   query = query.eq('client_id', clientId);
      if (fechaDesde) query = query.gte('created_at', fechaDesde);
      if (fechaHasta) {
        // Cota superior inclusiva del día SIN bug de zona horaria: created_at < (fechaHasta + 1 día).
        // (new Date(fechaHasta) parsea en UTC pero setHours es local → desfasaba el fin de día en UTC-3,
        //  por eso una sola fecha no traía nada.) Coincide con get_dashboard_metrics.
        const [yy, mm, dd] = fechaHasta.split('-').map(Number);
        const nextDay = new Date(Date.UTC(yy, mm - 1, dd + 1)).toISOString().slice(0, 10);
        query = query.lt('created_at', nextDay);
      }
      query = query
        .order('created_at', { ascending: false })
        .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

      const { data, error: fetchError, count } = await query;
      if (fetchError) {
        // PGRST103 = "Requested range not satisfiable": la página pedida excede el total (0 filas por
        // el filtro). No es un error real → mostrar vacío en vez del JSON crudo ({"...).
        if ((fetchError as { code?: string }).code === 'PGRST103') {
          setJobs([]);
          setTotalJobs(0);
          setError(null);
        } else {
          setError(fetchError.message);
          if (!hasLoadedOnce.current) setJobs([]);
        }
      } else {
        setJobs((data || []) as unknown as PdfJob[]);
        setTotalJobs(count ?? 0);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido al cargar procesos');
      if (!hasLoadedOnce.current) setJobs([]);
    } finally {
      hasLoadedOnce.current = true;
      setInitialLoading(false);
    }
  }, [organizationId, page, clientId, fechaDesde, fechaHasta]);

  // Refresca las métricas desde la RPC (debounced; ráfagas de Realtime/polling).
  const scheduleMetrics = () => {
    if (metricsTimer.current) clearTimeout(metricsTimer.current);
    metricsTimer.current = setTimeout(() => {
      fetchDashboardMetrics(filters).then((m) => { if (m) setMetrics(m); });
    }, 350);
  };

  // Refresca la página actual (debounced) ante cambios de Realtime.
  const scheduleRefetch = () => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => { loadPage(); }, 400);
  };

  useEffect(() => {
    if (authLoading) return;          // esperar a que auth resuelva
    if (!organizationId) return;      // profile aún llega en background — no flashear ceros

    if (!hasLoadedOnce.current) setInitialLoading(true);
    setError(null);
    loadPage();
    fetchDashboardMetrics(filters).then((m) => { if (m) setMetrics(m); });

    // Realtime: ante cualquier cambio en pdf_jobs, refetch de la página actual + métricas (debounced).
    const channel = supabase
      .channel('pdf_jobs_changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pdf_jobs' },
        () => { scheduleRefetch(); scheduleMetrics(); }
      )
      .subscribe();
    subscriptionRef.current = channel;

    return () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      if (metricsTimer.current) clearTimeout(metricsTimer.current);
      if (subscriptionRef.current) {
        supabase.removeChannel(subscriptionRef.current);
        subscriptionRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, authLoading, loadPage]);

  // ─── Polling de respaldo ─────────────────────────────────────────────────
  // Activo mientras haya jobs recientes (últimos 5 min) O en pending/processing.
  // Garantiza actualizaciones aunque Realtime falle o llegue tarde. Refetch de la página actual.
  useEffect(() => {
    const FIVE_MIN = 5 * 60 * 1000;
    const now = Date.now();
    const hasRelevant = jobs.some((j) => {
      const isActive = j.status === 'pending' || j.status === 'processing';
      const isRecent = now - new Date(j.created_at).getTime() < FIVE_MIN;
      return isActive || isRecent;
    });
    if (!hasRelevant || !organizationId) return;

    const intervalId = setInterval(() => { loadPage(); scheduleMetrics(); }, 8000);
    return () => clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, organizationId, loadPage]);

  // Efectividad GLOBAL del sistema (todas las orgs) — para comparar contra la del tenant.
  // Se trae una vez (no depende de filtros ni de la página). RPC SECURITY DEFINER (solo un número).
  useEffect(() => {
    if (!organizationId) return;
    supabase.rpc('get_system_avg_confidence').then(({ data, error }) => {
      if (!error && data != null) setSystemAvgConfidence(Number(data));
    });
  }, [organizationId]);

  const totalPages = Math.max(1, Math.ceil(totalJobs / PAGE_SIZE));

  return {
    jobs,
    loading: initialLoading || authLoading,
    error,
    metrics,
    page,
    setPage,
    totalJobs,
    totalPages,
    systemAvgConfidence,
    pageSize: PAGE_SIZE,
  };
}
