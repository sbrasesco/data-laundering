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
  doc_status?: string | null;
  is_duplicate?: boolean | null;
  warning_reason?: string | null;
  _row_type: 'factura' | 'oc';
  numero_oc?: string | null;
  nombre_adjunto?: string | null;
  codigo_obra?: string | null;
  [key: string]: any;
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
    rows_count?: number;
  };
  clients: { id: string; name: string } | null;
  pdf_job_row_oc?: { numero_oc: string; codigo_obra?: string | null; nombre_adjunto?: string | null }[];
}

export interface DocumentFilters {
  fechaDesde?: string;
  fechaHasta?: string;
  clientId?: string;
  searchText?: string;
}

const FACTURA_SELECT =
  '*, pdf_job_row_oc ( numero_oc, codigo_obra, nombre_adjunto ), pdf_jobs!inner ( id, created_at, status, total_documents, processed_documents, failed_documents, has_warnings, period_month, period_year, client_id, clients ( id, name ) )';

const OC_SELECT =
  'id, row_id, numero_oc, nombre_adjunto, codigo_obra, created_at, pdf_job_rows!inner ( job_id, fecha, proveedor, cuit, receptor_nombre, receptor_cuit, pdf_jobs!inner ( id, created_at, status, total_documents, processed_documents, failed_documents, has_warnings, period_month, period_year, client_id, clients ( id, name ) ) )';

export function useAllDocuments(filters?: DocumentFilters, page: number = 1, pageSize: number = 50) {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    async function fetchDocuments() {
      try {
        setLoading(true);
        setError(null);

        let jobIds: string[] | undefined;
        if (filters?.clientId) {
          const { data: jobsData } = await supabase
            .from('pdf_jobs')
            .select('id')
            .eq('client_id', filters.clientId);
          jobIds = jobsData?.map((j: any) => j.id) || [];
          if (jobIds.length === 0) {
            setDocuments([]);
            setTotalCount(0);
            setLoading(false);
            return;
          }
        }

        // Facturas
        let facturaQuery = supabase
          .from('pdf_job_rows')
          .select(FACTURA_SELECT, { count: 'exact' });

        if (filters?.fechaDesde) facturaQuery = facturaQuery.gte('fecha', filters.fechaDesde);
        if (filters?.fechaHasta) facturaQuery = facturaQuery.lte('fecha', filters.fechaHasta);
        if (jobIds && jobIds.length > 0) facturaQuery = facturaQuery.in('job_id', jobIds);

        facturaQuery = facturaQuery
          .order('created_at', { foreignTable: 'pdf_jobs', ascending: false })
          .order('id', { ascending: false })
          .range((page - 1) * pageSize, page * pageSize - 1);

        const { data, error: fetchError, count } = await facturaQuery;

        if (fetchError) {
          setError(fetchError.message);
          setDocuments([]);
          setTotalCount(0);
          return;
        }

        const jobRowCounts = new Map<string, number>();
        (data || []).forEach((row: any) => {
          if (row.job_id) jobRowCounts.set(row.job_id, (jobRowCounts.get(row.job_id) || 0) + 1);
        });

        const facturas: DocumentRow[] = (data || []).map((row: any) => ({
          ...row,
          _row_type: 'factura' as const,
          clients: row.pdf_jobs?.clients || null,
          pdf_jobs: row.pdf_jobs
            ? { ...row.pdf_jobs, rows_count: jobRowCounts.get(row.job_id) || 0 }
            : row.pdf_jobs,
        }));

        // Ordenes de Compra - solo las de las facturas de ESTA pagina.
        // Las facturas ya estan paginadas (.range) y filtradas (fecha/cliente); traer sus OCs
        // por row_id evita duplicar todas las OCs en cada pagina y la pagina fantasma que rompia (416).
        const facturaRowIds = (data || []).map((row: any) => row.id);
        let ocData: any[] | null = [];
        if (facturaRowIds.length > 0) {
          const ocRes = await supabase
            .from('pdf_job_row_oc')
            .select(OC_SELECT)
            .in('row_id', facturaRowIds);
          ocData = ocRes.data;
        }

        const ocRows: DocumentRow[] = (ocData || [])
          .map((oc: any) => {
            const padre = oc.pdf_job_rows;
            const job = padre?.pdf_jobs;
            return {
              id: 'oc-' + oc.id,
              job_id: padre?.job_id || '',
              fecha: padre?.fecha || null,
              moneda: null,
              es_moneda_ars: null,
              es_moneda_usd: null,
              tipo_documento: 'Orden de Compra',
              numero_comprobante: oc.numero_oc || null,
              proveedor: padre?.proveedor || null,
              cuit: padre?.cuit || null,
              receptor_nombre: padre?.receptor_nombre || null,
              receptor_cuit: padre?.receptor_cuit || null,
              neto_gravado: null,
              iva: null,
              total: null,
              _row_type: 'oc' as const,
              numero_oc: oc.numero_oc || null,
              nombre_adjunto: oc.nombre_adjunto || null,
              codigo_obra: oc.codigo_obra || null,
              pdf_jobs: job ? { ...job, rows_count: 0 } : null,
              clients: job?.clients || null,
            };
          });

        // Combinar y ordenar por fecha desc
        const combined = [...facturas, ...ocRows].sort((a, b) => {
          const fa = a.fecha || '';
          const fb = b.fecha || '';
          if (fb !== fa) return fb.localeCompare(fa);
          if (a._row_type !== b._row_type) return a._row_type === 'factura' ? -1 : 1;
          return 0;
        });

        setDocuments(combined);
        setTotalCount(count || 0); // paginamos por facturas; las OCs cuelgan de la factura de su pagina
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error desconocido al cargar documentos');
        setDocuments([]);
        setTotalCount(0);
      } finally {
        setLoading(false);
      }
    }

    fetchDocuments();
  }, [filters, page, pageSize, tick]);

  const refetch = () => setTick(t => t + 1);
  return { documents, loading, error, totalCount, refetch };
}
