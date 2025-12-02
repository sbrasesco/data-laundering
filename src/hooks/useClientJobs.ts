import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { PdfJob } from './usePdfJobs';

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

  useEffect(() => {
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

          // Calcular métricas
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

          setMetrics({
            jobsCount,
            totalDocuments,
            processedDocuments,
            failedDocuments,
            jobsWithWarnings,
            jobsWithError,
          });
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
  }, [filters?.clientId, filters?.fechaDesde, filters?.fechaHasta]);

  return { jobs, loading, error, metrics };
}

