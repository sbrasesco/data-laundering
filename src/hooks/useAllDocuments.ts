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

// DOCS-SEARCH-EXPORT-SERVER-SIDE (2026-08-21): el buscador y el export ahora operan sobre TODO
// el historial filtrado (antes: solo la pagina visible de 50). El filtro por cliente pasa al
// embed pdf_jobs!inner (.eq) — desaparece el pre-query de jobs y el .in(job_id,[...]) que crecia
// con el historico (misma bomba de URL que rompio Mis Procesos con ~650 jobs).
const EXPORT_MAX = 5000;
const OC_CHUNK = 500; // ids bigint cortos; en tandas la URL del .in() queda siempre chica

function sanitizeSearch(s: string | undefined): string | null {
  // Coma/parentesis rompen la sintaxis del .or() de PostgREST; % es wildcard de ilike.
  const t = (s ?? '').trim().replace(/[,()%]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length >= 2 ? t : null;
}

function applyFilters(query: any, filters?: DocumentFilters) {
  if (filters?.fechaDesde) query = query.gte('fecha', filters.fechaDesde);
  if (filters?.fechaHasta) query = query.lte('fecha', filters.fechaHasta);
  if (filters?.clientId) query = query.eq('pdf_jobs.client_id', filters.clientId);
  const s = sanitizeSearch(filters?.searchText);
  if (s) {
    query = query.or(
      `proveedor.ilike.%${s}%,receptor_nombre.ilike.%${s}%,numero_comprobante.ilike.%${s}%,cuit.ilike.%${s}%,receptor_cuit.ilike.%${s}%`
    );
  }
  return query;
}

async function fetchDocsWindow(
  filters: DocumentFilters | undefined,
  from: number,
  to: number,
): Promise<{ documents: DocumentRow[]; totalCount: number }> {
  // Facturas (paginadas y filtradas en el servidor)
  let facturaQuery = supabase
    .from('pdf_job_rows')
    .select(FACTURA_SELECT, { count: 'exact' });

  facturaQuery = applyFilters(facturaQuery, filters);

  facturaQuery = facturaQuery
    .order('created_at', { foreignTable: 'pdf_jobs', ascending: false })
    .order('id', { ascending: false })
    .range(from, to);

  const { data, error: fetchError, count } = await facturaQuery;

  if (fetchError) {
    throw new Error(fetchError.message);
  }

  const totalCount = count || 0;

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

  // Ordenes de Compra — solo las de las facturas de ESTA ventana, en tandas de OC_CHUNK ids
  // (los row_id son bigint cortos; la URL del .in() nunca crece con el historico).
  const facturaRowIds = (data || []).map((row: any) => row.id);
  let ocData: any[] = [];
  for (let i = 0; i < facturaRowIds.length; i += OC_CHUNK) {
    const ids = facturaRowIds.slice(i, i + OC_CHUNK);
    const ocRes = await supabase
      .from('pdf_job_row_oc')
      .select(OC_SELECT)
      .in('row_id', ids);
    if (ocRes.data) ocData = ocData.concat(ocRes.data);
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

  return { documents: combined, totalCount };
}

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

        const { documents: docs, totalCount: tc } = await fetchDocsWindow(
          filters,
          (page - 1) * pageSize,
          page * pageSize - 1,
        );
        setDocuments(docs);
        setTotalCount(tc);
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

/**
 * Export: trae TODO lo que matchea los filtros (hasta EXPORT_MAX facturas + sus OCs),
 * no solo la pagina visible. truncated=true si el filtro matchea mas que el tope.
 */
export async function fetchAllDocumentsForExport(
  filters?: DocumentFilters,
): Promise<{ documents: DocumentRow[]; totalCount: number; truncated: boolean }> {
  const { documents, totalCount } = await fetchDocsWindow(filters, 0, EXPORT_MAX - 1);
  return { documents, totalCount, truncated: totalCount > EXPORT_MAX };
}
