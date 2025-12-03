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
  processedDocuments: number;
  failedDocuments: number;
  jobsWithWarnings: number;
  jobsWithError: number;
}

export function useClientJobs(filters?: DashboardFilters) {
  const [jobs, setJobs] = useState<PdfJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<ClientJobsMetrics>({
    jobsCount: 0,
    totalDocuments: 0,
    processedDocuments: 0,
    failedDocuments: 0,
    jobsWithWarnings: 0,
    jobsWithError: 0,
  });
  const { organizationId } = useAuth();
  const subscriptionRef = useRef<any>(null);

  // Función para calcular métricas desde jobs
  const calculateMetrics = (jobsData: PdfJob[]): ClientJobsMetrics => {
    const jobsCount = jobsData.length;
    const totalDocuments = jobsData.reduce(
      (sum, job) => sum + (job.total_documents ?? 0),
      0
    );
    const processedDocuments = jobsData.reduce(
      (sum, job) => sum + (job.processed_documents ?? 0),
      0
    );
    const failedDocuments = jobsData.reduce(
      (sum, job) => sum + (job.failed_documents ?? 0),
      0
    );
    const jobsWithWarnings = jobsData.filter(
      (job) => job.has_warnings === true
    ).length;
    const jobsWithError = jobsData.filter(
      (job) => job.status === 'error'
    ).length;

    return {
      jobsCount,
      totalDocuments,
      processedDocuments,
      failedDocuments,
      jobsWithWarnings,
      jobsWithError,
    };
  };

  useEffect(() => {
    if (!organizationId) {
      setLoading(false);
      return;
    }

    async function fetchJobs() {
      try {
        setLoading(true);
        setError(null);

        let query = supabase
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
          `);

        // Filtrar por cliente si está presente en los filtros
        if (filters?.clientId) {
          query = query.eq('client_id', filters.clientId);
        }

        query = query.order('created_at', { ascending: false });

        // Aplicar filtros de fecha si existen
        if (filters?.fechaDesde) {
          query = query.gte('created_at', filters.fechaDesde);
        }
        if (filters?.fechaHasta) {
          // Agregar un día completo para incluir todo el día hasta
          const hastaDate = new Date(filters.fechaHasta);
          hastaDate.setHours(23, 59, 59, 999);
          query = query.lte('created_at', hastaDate.toISOString());
        }

        const { data, error: fetchError } = await query;

        if (fetchError) {
          setError(fetchError.message);
          setJobs([]);
          setMetrics({
            jobsCount: 0,
            totalDocuments: 0,
            processedDocuments: 0,
            failedDocuments: 0,
            jobsWithWarnings: 0,
            jobsWithError: 0,
          });
        } else {
          const jobsData = data || [];
          
          // Obtener los conteos de filas para cada job
          const jobIds = jobsData.map(job => job.id);
          let rowCountsMap = new Map<string, number>();
          
          if (jobIds.length > 0) {
            const { data: rowCountsData } = await supabase
              .from('pdf_job_rows')
              .select('job_id')
              .in('job_id', jobIds);

            if (rowCountsData) {
              rowCountsData.forEach(row => {
                const count = rowCountsMap.get(row.job_id) || 0;
                rowCountsMap.set(row.job_id, count + 1);
              });
            }
          }

          // Agregar rows_count a cada job
          const jobsWithCounts = jobsData.map(job => ({
            ...job,
            rows_count: rowCountsMap.get(job.id) || 0,
          }));

          setJobs(jobsWithCounts);
          setMetrics(calculateMetrics(jobsWithCounts));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error desconocido al cargar procesos');
        setJobs([]);
        setMetrics({
          jobsCount: 0,
          totalDocuments: 0,
          processedDocuments: 0,
          failedDocuments: 0,
          jobsWithWarnings: 0,
          jobsWithError: 0,
        });
      } finally {
        setLoading(false);
      }
    }

    fetchJobs();

    // Suscripción a Realtime para escuchar cambios en pdf_jobs
    // RLS asegura que solo recibimos eventos de jobs de nuestra organización
    const channel = supabase
      .channel('pdf_jobs_changes')
      .on(
        'postgres_changes',
        {
          event: '*', // INSERT, UPDATE, DELETE
          schema: 'public',
          table: 'pdf_jobs',
        },
        async (payload) => {
          // Mapeo de estados: done y done_with_warnings → "Completado"
          // El badge se actualiza automáticamente cuando cambia el status en la BD
          
          if (payload.eventType === 'UPDATE') {
            // Para UPDATE: obtener el job actualizado completo desde la BD
            // Esto asegura que tenemos todos los campos (incluyendo relaciones)
            const updatedJobId = (payload.new as any).id;
            
            try {
              const { data: jobData, error: jobError } = await supabase
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
                .eq('id', updatedJobId)
                .single();

              if (!jobError && jobData) {
                // Verificar si el job pasa los filtros actuales
                let passesFilters = true;
                if (filters?.clientId && jobData.client_id !== filters.clientId) {
                  passesFilters = false;
                }
                if (filters?.fechaDesde && new Date(jobData.created_at) < new Date(filters.fechaDesde)) {
                  passesFilters = false;
                }
                if (filters?.fechaHasta) {
                  const hastaDate = new Date(filters.fechaHasta);
                  hastaDate.setHours(23, 59, 59, 999);
                  if (new Date(jobData.created_at) > hastaDate) {
                    passesFilters = false;
                  }
                }

                // Obtener conteo de filas
                const { data: rowCountsData } = await supabase
                  .from('pdf_job_rows')
                  .select('job_id')
                  .eq('job_id', updatedJobId);

                const rowsCount = rowCountsData?.length || 0;

                setJobs((currentJobs) => {
                  const jobIndex = currentJobs.findIndex(j => j.id === updatedJobId);
                  
                  if (jobIndex === -1) {
                    // Si no está en la lista y pasa los filtros, agregarlo
                    if (passesFilters) {
                      const newJob = {
                        ...jobData,
                        rows_count: rowsCount,
                      };
                      const updated = [...currentJobs, newJob].sort((a, b) => 
                        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
                      );
                      setMetrics(calculateMetrics(updated));
                      return updated;
                    }
                    return currentJobs;
                  }
                  
                  // Si está en la lista pero ya no pasa los filtros, removerlo
                  if (!passesFilters) {
                    const filtered = currentJobs.filter(j => j.id !== updatedJobId);
                    setMetrics(calculateMetrics(filtered));
                    return filtered;
                  }
                  
                  // Actualizar el job existente
                  const updated = [...currentJobs];
                  updated[jobIndex] = {
                    ...jobData,
                    rows_count: rowsCount,
                  };
                  setMetrics(calculateMetrics(updated));
                  return updated;
                });
              }
            } catch (err) {
              console.error('Error al actualizar job desde Realtime (UPDATE):', err);
            }
          } else if (payload.eventType === 'INSERT') {
            // Para INSERT: refrescar toda la lista para incluir el nuevo job
            // Esto asegura que los filtros se apliquen correctamente
            try {
              let query = supabase
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
                `);

              if (filters?.clientId) {
                query = query.eq('client_id', filters.clientId);
              }
              if (filters?.fechaDesde) {
                query = query.gte('created_at', filters.fechaDesde);
              }
              if (filters?.fechaHasta) {
                const hastaDate = new Date(filters.fechaHasta);
                hastaDate.setHours(23, 59, 59, 999);
                query = query.lte('created_at', hastaDate.toISOString());
              }

              query = query.order('created_at', { ascending: false });

              const { data: jobsData, error: fetchError } = await query;

              if (!fetchError && jobsData) {
                const jobIds = jobsData.map(job => job.id);
                let rowCountsMap = new Map<string, number>();
                
                if (jobIds.length > 0) {
                  const { data: rowCountsData } = await supabase
                    .from('pdf_job_rows')
                    .select('job_id')
                    .in('job_id', jobIds);

                  if (rowCountsData) {
                    rowCountsData.forEach(row => {
                      const count = rowCountsMap.get(row.job_id) || 0;
                      rowCountsMap.set(row.job_id, count + 1);
                    });
                  }
                }

                const jobsWithCounts = jobsData.map(job => ({
                  ...job,
                  rows_count: rowCountsMap.get(job.id) || 0,
                }));

                setJobs(jobsWithCounts);
                setMetrics(calculateMetrics(jobsWithCounts));
              }
            } catch (err) {
              console.error('Error al actualizar jobs desde Realtime (INSERT):', err);
            }
          } else if (payload.eventType === 'DELETE') {
            // Para DELETE: remover el job de la lista
            const deletedJob = payload.old as any;
            setJobs((currentJobs) => {
              const filtered = currentJobs.filter(j => j.id !== deletedJob.id);
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
  }, [organizationId, filters?.clientId, filters?.fechaDesde, filters?.fechaHasta]);

  return { jobs, loading, error, metrics };
}

