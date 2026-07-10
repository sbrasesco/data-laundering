import { useMemo, useState, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { DocumentRow } from '../../hooks/useAllDocuments';
import { DocumentDetailModal } from './DocumentDetailModal';
import { formatDisplayDate } from '../../utils/dateFormat';
import { Badge } from '@/components/ui/badge';
import { warningReasonLabel } from '../../lib/documentClassification';
import { Button } from '@/components/ui/button';
import { EditRowModal } from '../pdf-jobs/EditRowModal';
import { supabase } from '../../lib/supabase';

const WORKER_GATEWAY_URL = import.meta.env.VITE_WORKER_GATEWAY_URL ?? 'https://api.agoradigital.io';
const WORKER_API_KEY     = import.meta.env.VITE_WORKER_API_KEY     ?? 'staging-key-2026';
const ACTIONABLE = new Set(['warning', 'failed', 'pending_approval']);

interface DocumentsTableProps {
  documents: DocumentRow[];
  onDocsChanged?: () => void;
}

type SortDir = 'asc' | 'desc';

interface ColDef {
  id: string;
  header: string;
  className?: string;
  sortable: boolean;
  getVal: (d: DocumentRow) => string | number | null;
}

const COLS: ColDef[] = [
  { id: 'fecha',     header: 'Fecha',        className: 'doc-table-date',      sortable: true,  getVal: (d) => d.fecha },
  { id: 'tipo',      header: 'Tipo',                                            sortable: true,  getVal: (d) => d._row_type === 'oc' ? 'OC' : (d.tipo_documento || '') },
  { id: 'proveedor', header: 'Proveedor',     className: 'doc-table-proveedor', sortable: true,  getVal: (d) => d.proveedor },
  { id: 'cuit',      header: 'CUIT',          className: 'doc-table-cuit',      sortable: true,  getVal: (d) => d.cuit },
  { id: 'receptor',  header: 'Receptor',      className: 'doc-table-receptor',  sortable: true,  getVal: (d) => d._row_type === 'oc' ? null : d.receptor_nombre },
  { id: 'numero',    header: 'Número / OC',   className: 'doc-table-numero',    sortable: true,  getVal: (d) => d._row_type === 'oc' ? (d.numero_oc || null) : d.numero_comprobante },
  { id: 'obra',      header: 'Cód. Obra',                                       sortable: true,  getVal: (d) => d._row_type === 'oc' ? (d.codigo_obra || null) : null },
  { id: 'moneda',    header: 'Moneda',                                          sortable: true,  getVal: (d) => d._row_type === 'oc' ? null : (d.es_moneda_usd ? 'USD' : 'ARS') },
  { id: 'neto',      header: 'Neto',          className: 'doc-table-neto',      sortable: true,  getVal: (d) => d._row_type === 'oc' ? null : d.neto_gravado },
  { id: 'iva',       header: 'IVA',           className: 'doc-table-iva',       sortable: true,  getVal: (d) => d._row_type === 'oc' ? null : d.iva },
  { id: 'total',     header: 'Total',                                           sortable: true,  getVal: (d) => d._row_type === 'oc' ? null : d.total },
  { id: 'estado',    header: 'Estado',                                          sortable: true,  getVal: (d) => d._row_type === 'oc' ? 'ok' : ((d.doc_status as string | undefined) ?? null) },
  { id: 'accion',    header: 'Acción',                                          sortable: false, getVal: () => null },
];

export function DocumentsTable({ documents, onDocsChanged }: DocumentsTableProps) {
  const [selectedDoc, setSelectedDoc] = useState<DocumentRow | null>(null);
  const [editRow, setEditRow] = useState<DocumentRow | null>(null);
  const [saving, setSaving]   = useState(false);

  const handleSaveEdit = async (rowId: number, updates: Record<string, any>) => {
    setSaving(true);
    try {
      const { error } = await supabase.from('pdf_job_rows').update({ ...updates, doc_status: 'pending_approval' }).eq('id', rowId);
      if (error) throw error;
      setEditRow(null);
      onDocsChanged?.();
    } catch (err) {
      console.error('Error guardando fila:', err);
      alert('Error al guardar. Intentá nuevamente.');
    } finally { setSaving(false); }
  };

  const handleSaveAndProcess = async (rowId: number, updates: Record<string, any>) => {
    setSaving(true);
    try {
      const { error: updateError } = await supabase.from('pdf_job_rows').update({ ...updates, doc_status: 'pending_approval' }).eq('id', rowId);
      if (updateError) throw updateError;
      const { data, error: approveError } = await supabase.rpc('approve_document_row', { p_row_id: rowId });
      if (approveError) throw approveError;
      if (data?.job_id && data?.org_id) {
        fetch(`${WORKER_GATEWAY_URL}/api/deposit-row`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WORKER_API_KEY}` },
          body: JSON.stringify({ row_id: rowId, job_id: data.job_id, org_id: data.org_id }),
        }).catch(() => {});
      }
      setEditRow(null);
      onDocsChanged?.();
    } catch (err) {
      console.error('Error guardando y procesando:', err);
      alert('Error al guardar y procesar. Intentá nuevamente.');
    } finally { setSaving(false); }
  };
  // Scroll horizontal arrastrando con el mouse (grab & pan).
  const scrollRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ down: false, moved: false, startX: 0, startLeft: 0 });

  const onDragStart = (e: ReactMouseEvent<HTMLDivElement>) => {
    const el = scrollRef.current; if (!el) return;
    drag.current = { down: true, moved: false, startX: e.pageX, startLeft: el.scrollLeft };
    el.style.cursor = 'grabbing'; el.style.userSelect = 'none';
  };
  const onDragMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    const el = scrollRef.current; if (!el || !drag.current.down) return;
    const dx = e.pageX - drag.current.startX;
    if (Math.abs(dx) > 4) drag.current.moved = true;
    el.scrollLeft = drag.current.startLeft - dx;
  };
  const onDragEnd = () => {
    const el = scrollRef.current;
    drag.current.down = false;
    if (el) { el.style.cursor = 'grab'; el.style.userSelect = ''; }
  };
  const onClickCaptureGuard = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (drag.current.moved) { e.preventDefault(); e.stopPropagation(); drag.current.moved = false; }
  };
  const [sortCol, setSortCol] = useState<string>('fecha');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const fmtCurrency = (v: unknown) => {
    if (v == null) return '-';
    const n = typeof v === 'string' ? parseFloat(v) : (v as number);
    if (isNaN(n)) return String(v);
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(n);
  };

  const handleSort = (id: string, sortable: boolean) => {
    if (!sortable) return;
    if (sortCol === id) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(id); setSortDir('asc'); }
  };

  const sorted = useMemo(() => {
    const col = COLS.find(c => c.id === sortCol);
    if (!col || !col.sortable) return documents;
    return [...documents].sort((a, b) => {
      const va = col.getVal(a);
      const vb = col.getVal(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      let cmp = 0;
      if (typeof va === 'number' && typeof vb === 'number') { cmp = va - vb; }
      else { cmp = String(va).localeCompare(String(vb), 'es', { numeric: true }); }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [documents, sortCol, sortDir]);

  const arrow = (id: string) => {
    if (sortCol !== id) return <span className="opacity-30 ml-1">↕</span>;
    return <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  const getMonedaBadge = (row: DocumentRow) => {
    if (row._row_type === 'oc') return <Badge variant="warning">-</Badge>;
    if (row.es_moneda_usd) return <Badge variant="info">USD</Badge>;
    return <Badge variant="success">ARS</Badge>;
  };

  const getStatusOnlyBadge = (st: string, reason?: string | null) => {
    switch (st) {
      case 'failed':           return <Badge variant="destructive">Fallido</Badge>;
      case 'warning': {
        const rl = warningReasonLabel(reason);
        return (
          <div className="flex flex-col items-start gap-0.5">
            <Badge variant="warning" title={rl ?? undefined}>Con advertencia</Badge>
            {rl && <span className="text-[11px] leading-tight text-muted-foreground">{rl}</span>}
          </div>
        );
      }
      case 'pending_approval': return <Badge variant="info">Pendiente de aprobación</Badge>;
      default:                 return <Badge variant="success">Exitoso</Badge>;
    }
  };

  // Estado del documento en sí (no del proceso). Las OCs existen porque se extrajeron correctamente → Exitoso.
  // Si el archivo fue detectado como duplicado (mismo CUIT+número ya existente), se suma un badge 'Duplicado'.
  const getDocStatusBadge = (row: DocumentRow) => {
    const st = row._row_type === 'oc' ? 'ok' : ((row.doc_status as string | undefined) ?? 'ok');
    const isDup = row._row_type !== 'oc' && row.is_duplicate === true;
    if (!isDup) return getStatusOnlyBadge(st, row.warning_reason);
    return (
      <div className="flex flex-col items-start gap-1">
        {getStatusOnlyBadge(st, row.warning_reason)}
        <Badge
          variant="outline"
          className="border-orange-400 text-orange-600"
          title="Documento duplicado: ya existe uno con el mismo CUIT + número de comprobante"
        >
          Duplicado
        </Badge>
      </div>
    );
  };

  if (documents.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">No se encontraron documentos con estos filtros.</p>
      </div>
    );
  }

  return (
    <div>
      <style>{`
        @media (max-width: 1200px) {
          .doc-table-cuit, .doc-table-receptor, .doc-table-neto, .doc-table-iva { display: none; }
        }
        @media (max-width: 768px) {
          .doc-table-cuit, .doc-table-receptor, .doc-table-neto, .doc-table-iva,
          .doc-table-numero, .doc-table-proveedor { display: none; }
        }
        tr.oc-row { background-color: rgba(99,102,241,0.04); border-left: 3px solid #6366f1; }
        .sort-th:hover { background-color: hsl(var(--muted)); }
        thead th { position: sticky; top: 0; z-index: 10; background: hsl(var(--muted)); }
      `}</style>
      <div
        ref={scrollRef}
        onMouseDown={onDragStart}
        onMouseMove={onDragMove}
        onMouseUp={onDragEnd}
        onMouseLeave={onDragEnd}
        onClickCapture={onClickCaptureGuard}
        className="rounded-lg border bg-card overflow-auto"
        style={{ cursor: 'grab', maxHeight: '70vh' }}
      >
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b bg-muted/50">
              {COLS.map(col => (
                <th
                  key={col.id}
                  className={[
                    'px-3 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide whitespace-nowrap',
                    col.className || '',
                    col.sortable ? 'sort-th cursor-pointer select-none' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => handleSort(col.id, col.sortable)}
                >
                  {col.header}{col.sortable && arrow(col.id)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sorted.map((doc) => {
              const isOC = doc._row_type === 'oc';
              return (
                <tr key={doc.id} className={isOC ? 'oc-row' : 'hover:bg-muted/30 transition-colors'}>
                  <td className="doc-table-date px-3 py-2 text-sm whitespace-nowrap">{formatDisplayDate(doc.fecha)}</td>
                  <td className="px-3 py-2">
                    {isOC
                      ? <Badge className="border-transparent text-white" style={{ background: '#A347D1' }}>OC</Badge>
                      : <span className="text-xs text-muted-foreground">{doc.tipo_documento || 'Comprobante'}</span>
                    }
                  </td>
                  <td className="doc-table-proveedor px-3 py-2 text-sm">{doc.proveedor || '-'}</td>
                  <td className="doc-table-cuit px-3 py-2 text-sm">{doc.cuit || '-'}</td>
                  <td className="doc-table-receptor px-3 py-2 text-sm">{isOC ? '-' : (doc.receptor_nombre || '-')}</td>
                  <td className="doc-table-numero px-3 py-2 text-sm">
                    {isOC
                      ? <span className="font-medium">{doc.numero_oc || '-'}</span>
                      : (doc.numero_comprobante || '-')
                    }
                  </td>
                  <td className="px-3 py-2 text-sm">
                    {isOC && doc.codigo_obra
                      ? <span className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold text-white" style={{ background: '#A347D1' }}>{doc.codigo_obra}</span>
                      : <span className="text-muted-foreground">-</span>
                    }
                  </td>
                  <td className="px-3 py-2">{getMonedaBadge(doc)}</td>
                  <td className="doc-table-neto px-3 py-2 text-sm tabular-nums">{isOC ? '-' : fmtCurrency(doc.neto_gravado)}</td>
                  <td className="doc-table-iva px-3 py-2 text-sm tabular-nums">{isOC ? '-' : fmtCurrency(doc.iva)}</td>
                  <td className="px-3 py-2 text-sm font-medium tabular-nums">{isOC ? '-' : fmtCurrency(doc.total)}</td>
                  <td className="px-3 py-2">
                    {getDocStatusBadge(doc)}
                  </td>
                  <td className="px-3 py-2">
                    {isOC
                      ? <span className="text-xs text-muted-foreground">{doc.nombre_adjunto || '-'}</span>
                      : (ACTIONABLE.has((doc.doc_status as string) ?? 'ok')
                          ? <Button size="sm" variant="outline" onClick={() => setEditRow(doc)}>Editar</Button>
                          : <Button size="sm" onClick={() => setSelectedDoc(doc)}>Ver documento</Button>)
                    }
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <DocumentDetailModal document={selectedDoc} onClose={() => setSelectedDoc(null)} />
      <EditRowModal
        row={editRow}
        onClose={() => setEditRow(null)}
        onSave={handleSaveEdit}
        onSaveAndProcess={handleSaveAndProcess}
        saving={saving}
      />
    </div>
  );
}
