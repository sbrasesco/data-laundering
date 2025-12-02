import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

export interface DocumentRow {
  id: string | number;
  job_id: string;
  fecha: string | null;
  moneda: string | null;
  es_moneda_ars: boolean | null;
  es_moneda_usd: boolean | null;
  tipo_documento: string | null;
  numero_comprobante: string | null;
  proveedor: string | null;
  cuit: string | null;
  receptor_nombre: string | null;
  receptor_cuit: string | null;
  neto_gravado: number | null;
  iva: number | null;
  total: number | null;
  [key: string]: any; // Para otros campos dinámicos
  pdf_jobs: {
    id: string;
    created_at: string;
    status: 'pending' | 'processing' | 'done' | 'error';
    total_documents: number | null;
    processed_documents: number | null;
    failed_documents: number | null;
    has_warnings: boolean | null;
    period_month: number | null;
    period_year: number | null;
    client_id: string | null;
    rows_count?: number; // se calculará en el hook
  };
  clients: {
    id: string;
    name: string;
  } | null;
}

export interface DocumentFilters {
  fechaDesde?: string;
  fechaHasta?: string;
  clientId?: string;
  searchText?: string;
}

export function useAllDocuments(filters?: DocumentFilters, page: number = 1, pageSize: number = 50) {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);

  useEffect(() => {
    async function fetchDocuments() {
      try {
        setLoading(true);
        setError(null);

        // Si hay filtro de cliente, primero obtenemos los job_ids
        let jobIds: string[] | undefined;
        if (filters?.clientId) {
          const { data: jobsData } = await supabase
            .from('pdf_jobs')
            .select('id')
            .eq('client_id', filters.clientId);
          jobIds = jobsData?.map(j => j.id) || [];
          if (jobIds.length === 0) {
            // Si no hay jobs para este cliente, retornar vacío
            setDocuments([]);
            setTotalCount(0);
            setLoading(false);
            return;
          }
        }

        let query = supabase
          .from('pdf_job_rows')
          .select(`
            *,
            pdf_jobs!inner (
              id,
              created_at,
              status,
              total_documents,
              processed_documents,
              failed_documents,
              has_warnings,
              period_month,
              period_year,
              client_id,
              clients (
                id,
                name
              )
            )
          `, { count: 'exact' });

        // Aplicar filtros
        if (filters?.fechaDesde) {
          query = query.gte('fecha', filters.fechaDesde);
        }
        if (filters?.fechaHasta) {
          query = query.lte('fecha', filters.fechaHasta);
        }
        if (jobIds && jobIds.length > 0) {
          query = query.in('job_id', jobIds);
        }

        // Ordenar
        query = query
          .order('created_at', { foreignTable: 'pdf_jobs', ascending: false })
          .order('id', { ascending: false });

        // Paginación
        const from = (page - 1) * pageSize;
        const to = from + pageSize - 1;
        query = query.range(from, to);

        const { data, error: fetchError, count } = await query;

        if (fetchError) {
          setError(fetchError.message);
          setDocuments([]);
          setTotalCount(0);
        } else {
          // Calcular el conteo de filas por job_id
          const jobRowCounts = new Map<string, number>();
          (data || []).forEach((row: any) => {
            if (row.job_id) {
              const currentCount = jobRowCounts.get(row.job_id) || 0;
              jobRowCounts.set(row.job_id, currentCount + 1);
            }
          });

          // Transformar los datos para aplanar la estructura y agregar rows_count
          const transformedData = (data || []).map((row: any) => ({
            ...row,
            clients: row.pdf_jobs?.clients || null,
            pdf_jobs: row.pdf_jobs ? {
              ...row.pdf_jobs,
              rows_count: jobRowCounts.get(row.job_id) || 0,
            } : row.pdf_jobs,
          }));
          
          setDocuments(transformedData);
          setTotalCount(count || 0);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error desconocido al cargar documentos');
        setDocuments([]);
        setTotalCount(0);
      } finally {
        setLoading(false);
      }
    }

    fetchDocuments();
  }, [filters, page, pageSize]);

  return { documents, loading, error, totalCount };
}

