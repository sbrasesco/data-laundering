import { useState, useEffect, useRef } from 'react';
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
  error_message,
  created_at,
  period_month,
  period_year,
  clients ( id, name )
`;

export function useClientJobs(filters?: DashboardFilters) {
  const [jobs, setJobs] = useState<PdfJob[]>([]);
  // initialLoading: true solo en la primera carga (sin datos todavía)
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<ClientJobsMetrics>({
    jobsCount: 0,
    totalDocuments: 0,
    processedDocuments: 0,
    failedDocuments: 0,
    documentsWithWarnings: 0,
    jobsWithError: 0,
  });
  const { organizationId, loading: authLoading } = useAuth();
  const subscriptionRef = useRef<any>(null);
  const hasLoadedOnce = useRef(false);

  // Métricas leídas de pdf_jobs (escritas por el worker/document-processor)
  const calculateMetrics = (jobsData: PdfJob[]): ClientJobsMetrics => {
    const jobsCount = jobsData.length;

    const totalDocuments = jobsData.reduce(
      (sum, job) => sum + (job.total_documents ?? 0),
      0
    );
    // processed_documents = documentos OK (clasificados por completitud de campos)
    const processedDocuments = jobsData.reduce(
      (sum, job) => sum + (job.processed_documents ?? 0),
      0
    );
    // failed_documents = documentos con campos insuficientes
    const failedDocuments = jobsData.reduce(
      (sum, job) => sum + (job.failed_documents ?? 0),
      0
    );
    // Advertencias: docs con datos incompletos (low_confidence_documents en la DB)
    const documentsWithWarnings = jobsData.reduce(
      (sum, job) => sum + (job.low_confidence_documents ?? 0),
      0
    );
    const correctedDocuments = jobsData.reduce(
      (sum, job) => sum + (job.corrected_documents ?? 0),
      0
    );
    const jobsWithError = jobsData.filter((job) => job.status === 'error').length;

    return {
      jobsCount,
      totalDocuments,
      processedDocuments,
      failedDocuments,
      documentsWithWarnings,
      correctedDocuments,
      jobsWithError,
    };
  };

  useEffect(() => {
    if (authLoading) return; // esperar a que auth resuelva antes de decidir
    if (!organizationId) {
      // authLoading=false pero organizationId=null: profile aún llega en background.
      // Mantener loading=true para evitar flash de métricas en cero.
      return;
    }

    async function fetchJobs() {
      try {
        // Solo mostrar spinner en la primera carga real (sin datos previos)
        if (!hasLoadedOnce.current) {
          setInitialLoading(true);
        }
        setError(null);

        let query = supabase.from('pdf_jobs').select(PDF_JOBS_SELECT);

        if (filters?.clientId) {
          query = query.eq('client_id', filters.clientId);
        }

        query = query.order('created_at', { ascending: false });

        if (filters?.fechaDesde) {
          query = query.gte('created_at', filters.fechaDesde);
        }
        if (filters?.fechaHasta) {
          const hastaDate = new Date(filters.fechaHasta);
          hastaDate.setHours(23, 59, 59, 999);
          query = query.lte('created_at', hastaDate.toISOString());
        }

        const { data, error: fetchError } = await query;

        if (fetchError) {
          setError(fetchError.message);
          if (!hasLoadedOnce.current) setJobs([]);
        } else {
          const jobsData = (data || []) as unknown as PdfJob[];
          setJobs(jobsData);
          setMetrics(calculateMetrics(jobsData));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error desconocido al cargar procesos');
        if (!hasLoadedOnce.current) setJobs([]);
      } finally {
        hasLoadedOnce.current = true;
        setInitialLoading(false);
      }
    }

    fetchJobs();

    // Suscripción Realtime — solo escucha pdf_jobs, sin queries adicionales
    const channel = supabase
      .channel('pdf_jobs_changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pdf_jobs' },
        async (payload) => {
          if (payload.eventType === 'UPDATE') {
            const updatedJobId = (payload.new as any).id;

            try {
              const { data: jobData, error: jobError } = await supabase
                .from('pdf_jobs')
                .select(PDF_JOBS_SELECT)
                .eq('id', updatedJobId)
                .single();

              if (!jobError && jobData) {
                let passesFilters = true;
                if (filters?.clientId && (jobData as any).client_id !== filters.clientId) {
                  passesFilters = false;
                }
                if (filters?.fechaDesde && new Date(jobData.created_at) < new Date(filters.fechaDesde)) {
                  passesFilters = false;
                }
                if (filters?.fechaHasta) {
                  const hastaDate = new Date(filters.fechaHasta);
                  hastaDate.setHours(23, 59, 59, 999);
                  if (new Date(jobData.created_at) > hastaDate) passesFilters = false;
                }

                setJobs((currentJobs) => {
                  const jobIndex = currentJobs.findIndex((j) => j.id === updatedJobId);
                  const updatedJob = jobData as unknown as PdfJob;

                  if (jobIndex === -1) {
                    if (passesFilters) {
                      const updated = [...currentJobs, updatedJob].sort(
                        (a, b) =>
                          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
                      );
                      setMetrics(calculateMetrics(updated));
                      return updated;
                    }
                    return currentJobs;
                  }

                  if (!passesFilters) {
                    const filtered = currentJobs.filter((j) => j.id !== updatedJobId);
                    setMetrics(calculateMetrics(filtered));
                    return filtered;
                  }

                  const updated = [...currentJobs];
                  updated[jobIndex] = updatedJob;
                  setMetrics(calculateMetrics(updated));
                  return updated;
                });
              }
            } catch (err) {
              console.error('Error al actualizar job desde Realtime (UPDATE):', err);
            }
          } else if (payload.eventType === 'INSERT') {
            // Agregar solo el job nuevo sin refetch completo (sin parpadeo)
            const newJobId = (payload.new as any).id;
            try {
              const { data: jobData, error: jobError } = await supabase
                .from('pdf_jobs')
                .select(PDF_JOBS_SELECT)
                .eq('id', newJobId)
                .single();

              if (!jobError && jobData) {
                const newJob = jobData as unknown as PdfJob;

                // Verificar filtros básicos antes de agregar
                const newRaw = payload.new as any;
                if (filters?.clientId && newRaw.client_id !== filters.clientId) return;

                setJobs((currentJobs) => {
                  // Evitar duplicados
                  if (currentJobs.some((j) => j.id === newJobId)) return currentJobs;
                  const updated = [newJob, ...currentJobs].sort(
                    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
                  );
                  setMetrics(calculateMetrics(updated));
                  return updated;
                });
              }
            } catch (err) {
              console.error('Error al agregar job desde Realtime (INSERT):', err);
            }
          } else if (payload.eventType === 'DELETE') {
            const deletedJob = payload.old as any;
            setJobs((currentJobs) => {
              const filtered = currentJobs.filter((j) => j.id !== deletedJob.id);
              setMetrics(calculateMetrics(filtered));
              return filtered;
            });
          }
        }
      )
      .subscribe();

    subscriptionRef.current = channel;

    return () => {
      if (subscriptionRef.current) {
        supabase.removeChannel(subscriptionRef.current);
        subscriptionRef.current = null;
      }
    };
  }, [organizationId, authLoading, filters?.clientId, filters?.fechaDesde, filters?.fechaHasta]);

  // ─── Polling de respaldo ─────────────────────────────────────────────────
  // Activo mientras haya jobs recientes (últimos 5 min) O en pending/processing.
  // Garantiza actualizaciones aunque Realtime falle o llegue tarde.
  useEffect(() => {
    const FIVE_MIN = 5 * 60 * 1000;
    const now = Date.now();
    const hasRelevant = jobs.some((j) => {
      const isActive = j.status === 'pending' || j.status === 'processing';
      const isRecent = now - new Date(j.created_at).getTime() < FIVE_MIN;
      return isActive || isRecent;
    });
    if (!hasRelevant || !organizationId) return;

    async function pollJobs() {
      try {
        let query = supabase.from('pdf_jobs').select(PDF_JOBS_SELECT);
        if (filters?.clientId)  query = query.eq('client_id', filters.clientId);
        if (filters?.fechaDesde) query = query.gte('created_at', filters.fechaDesde);
        if (filters?.fechaHasta) {
          const h = new Date(filters.fechaHasta);
          h.setHours(23, 59, 59, 999);
          query = query.lte('created_at', h.toISOString());
        }
        query = query.order('created_at', { ascending: false });

        const { data, error: pollError } = await query;
        if (!pollError && data) {
          const jobsData = data as unknown as PdfJob[];
          // Actualizar si cambió status, has_warnings o failed_documents
          const hasChange = jobsData.some((fresh) => {
            const current = jobs.find((j) => j.id === fresh.id);
            if (!current) return true;
            return (
              current.status          !== fresh.status          ||
              current.has_warnings    !== fresh.has_warnings    ||
              current.failed_documents !== fresh.failed_documents
            );
          });
          if (hasChange) {
            setJobs(jobsData);
            setMetrics(calculateMetrics(jobsData));
          }
        }
      } catch (_) {
        // Silencioso: el polling nunca debe romper la UI
      }
    }

    const intervalId = setInterval(pollJobs, 8000);
    return () => clearInterval(intervalId);
  }, [jobs, organizationId, filters?.clientId, filters?.fechaDesde, filters?.fechaHasta]);

  return { jobs, loading: initialLoading || authLoading, error, metrics };
}
