import { useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Button } from '@/components/ui/button';
import { EditRowModal } from './EditRowModal';

interface JobRowsTableProps {
  rows: any[];
  jobId: string;
  orgId: string;
  onRowUpdated: () => void;
}

type ColType = 'text' | 'currency' | 'date' | 'percent' | 'oc_list' | 'obra_list';
type SortDir = 'asc' | 'desc';

interface ColDef {
  header: string;
  getValue: (row: any) => any;
  type: ColType;
  numericSort?: boolean;
  tdStyle?: React.CSSProperties;
}

const COLUMNS: ColDef[] = [
  { header: 'Emisor',          getValue: (r) => r.proveedor,                  type: 'text',     tdStyle: { maxWidth: '244px', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'left' } },
  { header: 'CUIT Emisor',     getValue: (r) => r.cuit,                       type: 'text' },
  { header: 'Cond. IVA',       getValue: (r) => r.condicion_iva_emisor,       type: 'text' },
  { header: 'Tipo',            getValue: (r) => r.tipo_documento,             type: 'text' },
  { header: 'Cod. AFIP',       getValue: (r) => r.codigo_afip,                type: 'text' },
  { header: 'Nro. Comprobante',getValue: (r) => r.numero_comprobante,         type: 'text' },
  { header: 'Fecha Emision',   getValue: (r) => r.fecha,                      type: 'date' },
  { header: 'Nro. CAE',        getValue: (r) => r.nro_cae ?? r.cae,           type: 'text' },
  { header: 'Vto. CAE',        getValue: (r) => r.fecha_vto_cae,              type: 'date' },
  { header: 'Neto Gravado',    getValue: (r) => r.neto_gravado,               type: 'currency', numericSort: true },
  { header: 'Monto Exento',    getValue: (r) => r.monto_exento,               type: 'currency', numericSort: true },
  { header: 'IVA 27%',         getValue: (r) => r.iva_27,                     type: 'currency', numericSort: true },
  { header: 'IVA 21%',         getValue: (r) => r.iva_21,                     type: 'currency', numericSort: true },
  { header: 'IVA 10,5%',       getValue: (r) => r.iva_105,                    type: 'currency', numericSort: true },
  { header: 'IVA 5%',          getValue: (r) => r.iva_5,                      type: 'currency', numericSort: true },
  { header: 'IVA Total',       getValue: (r) => { const d = (r.iva_27 ?? 0) + (r.iva_21 ?? 0) + (r.iva_105 ?? 0) + (r.iva_5 ?? 0) + (r.iva_25 ?? 0); return d > 0 ? d : (r.iva ?? null); }, type: 'currency', numericSort: true },
  { header: 'Perc. IIBB',      getValue: (r) => r.percepcion_ingresos_brutos, type: 'currency', numericSort: true },
  { header: 'Perc. IVA',       getValue: (r) => r.percepcion_iva,             type: 'currency', numericSort: true },
  { header: 'Imp. Internos',   getValue: (r) => r.impuestos_internos,         type: 'currency', numericSort: true },
  { header: 'Total',           getValue: (r) => r.total,                      type: 'currency', numericSort: true },
  { header: 'Ordenes de Compra',getValue: (r) => r.pdf_job_row_oc,            type: 'oc_list' },
  { header: 'Codigo Obra',     getValue: (r) => r.pdf_job_row_oc,             type: 'obra_list' },
];

const REQUIRED_HEADERS = new Set([
  'Emisor', 'CUIT Emisor', 'Tipo', 'Cod. AFIP', 'Nro. Comprobante', 'Fecha Emision', 'Total',
]);

const TH_STYLE: React.CSSProperties = {
  cursor: 'pointer',
  userSelect: 'none',
  textAlign: 'center',
  verticalAlign: 'bottom',
  lineHeight: 1.3,
};

const TD_STYLE: React.CSSProperties = {
  fontSize: '0.875rem',
  textAlign: 'center',
  whiteSpace: 'nowrap',
};

function HeaderLabel({ text }: { text: string }) {
  const words = text.split(' ');
  if (words.length === 1) return <>{text}</>;
  return <>{words.map((w, i) => <span key={i}>{i > 0 && <br />}{w}</span>)}</>;
}

const WORKER_GATEWAY_URL = import.meta.env.VITE_WORKER_GATEWAY_URL ?? 'https://api.agoradigital.io';
const WORKER_API_KEY     = import.meta.env.VITE_WORKER_API_KEY     ?? 'staging-key-2026';

export function JobRowsTable({ rows, jobId, orgId, onRowUpdated }: JobRowsTableProps) {
  const [sortCol, setSortCol] = useState<number>(-1);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [editRow, setEditRow] = useState<any | null>(null);
  const [saving, setSaving] = useState(false);
  const [approvingId, setApprovingId] = useState<number | null>(null);

  const fmtCurrency = (v: any) => {
    if (v == null) return '-';
    const n = typeof v === 'string' ? parseFloat(v) : v;
    if (isNaN(n)) return String(v);
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(n);
  };

  const fmtDate = (v: any) => {
    if (v == null) return '-';
    try {
      const d = new Date(String(v));
      if (isNaN(d.getTime())) return String(v);
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const yyyy = d.getUTCFullYear();
      return `${dd}-${mm}-${yyyy}`;
    } catch { return String(v); }
  };

  const fmtOcList = (v: any) => {
    if (!Array.isArray(v) || v.length === 0) return '-';
    return v.map((oc: any) => oc?.numero_oc ?? oc).filter(Boolean).join(', ') || '-';
  };

  const fmtObraList = (v: any) => {
    if (!Array.isArray(v) || v.length === 0) return '-';
    const obras = [...new Set(v.map((oc: any) => oc?.codigo_obra).filter(Boolean))] as string[];
    return obras.length > 0 ? obras.join(', ') : '-';
  };

  const fmtCell = (col: ColDef, row: any): string => {
    const v = col.getValue(row);
    if (v == null) return '-';
    if (col.type === 'currency') return fmtCurrency(v);
    if (col.type === 'date') return fmtDate(v);
    if (col.type === 'percent') { const n = parseFloat(v); return isNaN(n) ? '-' : n.toFixed(1) + '%'; }
    if (col.type === 'oc_list') return fmtOcList(v);
    if (col.type === 'obra_list') return fmtObraList(v);
    return String(v);
  };

  const handleSort = (idx: number) => {
    if (sortCol === idx) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(idx); setSortDir('asc'); }
  };

  const sorted = useMemo(() => {
    if (sortCol < 0) return rows;
    const col = COLUMNS[sortCol];
    return [...rows].sort((a, b) => {
      const va = col.getValue(a);
      const vb = col.getValue(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      let cmp = 0;
      if (col.numericSort) {
        const na = parseFloat(String(va));
        const nb = parseFloat(String(vb));
        cmp = isNaN(na) || isNaN(nb) ? 0 : na - nb;
      } else if (col.type === 'date') {
        cmp = String(va).localeCompare(String(vb));
      } else {
        cmp = String(va).localeCompare(String(vb), 'es', { numeric: true });
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [rows, sortCol, sortDir]);

  const arrow = (idx: number) => {
    if (sortCol !== idx) return <span style={{ opacity: 0.3, marginLeft: 3 }}>&#8597;</span>;
    return <span style={{ marginLeft: 3 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  const handleSaveEdit = async (rowId: number, updates: Record<string, any>) => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from('pdf_job_rows')
        .update({ ...updates, doc_status: 'pending_approval' })
        .eq('id', rowId);
      if (error) throw error;
      setEditRow(null);
      onRowUpdated();
    } catch (err) {
      console.error('Error guardando fila:', err);
      alert('Error al guardar. Intentá nuevamente.');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAndProcess = async (rowId: number, updates: Record<string, any>) => {
    setSaving(true);
    try {
      const { error: updateError } = await supabase
        .from('pdf_job_rows')
        .update({ ...updates, doc_status: 'pending_approval' })
        .eq('id', rowId);
      if (updateError) throw updateError;

      const { data, error: approveError } = await supabase.rpc('approve_document_row', { p_row_id: rowId });
      if (approveError) throw approveError;

      if (data?.job_id && data?.org_id) {
        fetch(`${WORKER_GATEWAY_URL}/api/deposit-row`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${WORKER_API_KEY}`,
          },
          body: JSON.stringify({ row_id: rowId, job_id: data.job_id, org_id: data.org_id }),
        }).catch(() => {});
      }

      setEditRow(null);
      onRowUpdated();
    } catch (err) {
      console.error('Error guardando y procesando:', err);
      alert('Error al guardar y procesar. Intentá nuevamente.');
    } finally {
      setSaving(false);
    }
  };

  const handleApprove = async (row: any) => {
    setApprovingId(row.id);
    try {
      const { data, error } = await supabase.rpc('approve_document_row', { p_row_id: row.id });
      if (error) throw error;

      // Best-effort: depositar en integración de salida si está configurada
      if (data?.job_id && data?.org_id) {
        fetch(`${WORKER_GATEWAY_URL}/api/deposit-row`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${WORKER_API_KEY}`,
          },
          body: JSON.stringify({ row_id: row.id, job_id: data.job_id, org_id: data.org_id }),
        }).catch(() => {/* best-effort */});
      }

      onRowUpdated();
    } catch (err) {
      console.error('Error aprobando fila:', err);
      alert('Error al aprobar. Intentá nuevamente.');
    } finally {
      setApprovingId(null);
    }
  };

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          Este proceso aun no tiene filas procesadas.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="rounded-lg border bg-card overflow-x-auto max-h-[75vh] overflow-y-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur-sm">
            <tr className="border-b">
              {COLUMNS.map((col, i) => (
                <th
                  key={col.header}
                  onClick={() => handleSort(i)}
                  style={TH_STYLE}
                  className="px-3 py-2.5 text-xs font-medium text-muted-foreground"
                >
                  <HeaderLabel text={col.header} />{arrow(i)}
                </th>
              ))}
              <th
                style={{ ...TH_STYLE, cursor: 'default' }}
                className="px-3 py-2.5 text-xs font-medium text-muted-foreground"
              >
                Revisión
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, index) => {
              const status: string = row.doc_status ?? 'ok';
              const rowBaseStyle = status === 'failed'
                ? { backgroundColor: 'rgba(220, 53, 69, 0.08)', borderLeft: '3px solid hsl(var(--destructive))' }
                : status === 'warning'
                ? { backgroundColor: 'rgba(245, 158, 11, 0.08)', borderLeft: '3px solid #f59e0b' }
                : status === 'pending_approval'
                ? { backgroundColor: 'rgba(59, 130, 246, 0.08)', borderLeft: '3px solid #3b82f6' }
                : undefined;
              const needsAction = status === 'failed' || status === 'warning' || status === 'pending_approval';
              return (
                <tr key={index} style={rowBaseStyle} className="border-b hover:bg-muted/30 transition-colors">
                  {COLUMNS.map((col) => {
                    const cellText = fmtCell(col, row);
                    const missingRequired = needsAction && REQUIRED_HEADERS.has(col.header) && (cellText === '-' || cellText === '');
                    const cellStyle: React.CSSProperties = {
                      ...TD_STYLE,
                      ...col.tdStyle,
                      ...(missingRequired ? { backgroundColor: 'rgba(220, 53, 69, 0.15)', color: 'hsl(var(--destructive))', fontWeight: 600 } : {}),
                    };
                    return (
                      <td
                        key={col.header}
                        style={cellStyle}
                        title={missingRequired ? 'Campo faltante' : (cellText !== '-' ? cellText : undefined)}
                        className="px-3 py-2"
                      >
                        {missingRequired ? '⚠ —' : cellText}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-center whitespace-nowrap">
                    <div className="flex gap-1 justify-center items-center">
                      {row.is_duplicate && (
                        <span
                          className="text-xs font-medium px-2 py-0.5 rounded-full border border-orange-400 text-orange-600"
                          title="Documento duplicado: ya existe uno con el mismo CUIT + número de comprobante"
                        >
                          Duplicado
                        </span>
                      )}
                      {needsAction && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-xs"
                            onClick={() => setEditRow(row)}
                            disabled={approvingId === row.id}
                          >
                            Editar
                          </Button>
                          {status === 'pending_approval' && (
                            <Button
                              size="sm"
                              className="h-6 px-2 text-xs bg-green-600 hover:bg-green-700 text-white"
                              onClick={() => handleApprove(row)}
                              disabled={approvingId === row.id}
                            >
                              {approvingId === row.id ? '...' : 'Aprobar'}
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <EditRowModal
        row={editRow}
        onClose={() => setEditRow(null)}
        onSave={handleSaveEdit}
        onSaveAndProcess={handleSaveAndProcess}
        saving={saving}
      />
    </>
  );
}
