import { useMemo, useState } from 'react';

interface JobRowsTableProps {
  rows: any[];
}

type ColType = 'text' | 'currency' | 'date' | 'percent' | 'oc_list' | 'obra_list';
type SortDir = 'asc' | 'desc';

interface ColDef {
  header: string;
  getValue: (row: any) => any;
  type: ColType;
  numericSort?: boolean;
  tdStyle?: React.CSSProperties; // estilo adicional por columna
}

const COLUMNS: ColDef[] = [
  {
    header: 'Emisor',
    getValue: (r) => r.proveedor,
    type: 'text',
    // Columna acotada: texto largo se trunca con "..." y se ve completo en tooltip (hover)
    tdStyle: { maxWidth: '244px', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'left' },
  },
  { header: 'CUIT Emisor',       getValue: (r) => r.cuit,                       type: 'text' },
  { header: 'Cond. IVA',         getValue: (r) => r.condicion_iva_emisor,       type: 'text' },
  { header: 'Tipo',              getValue: (r) => r.tipo_documento,             type: 'text' },
  { header: 'Cod. AFIP',         getValue: (r) => r.codigo_afip,                type: 'text' },
  { header: 'Nro. Comprobante',  getValue: (r) => r.numero_comprobante,         type: 'text' },
  { header: 'Fecha Emision',     getValue: (r) => r.fecha,                      type: 'date' },
  { header: 'Nro. CAE',          getValue: (r) => r.nro_cae ?? r.cae,           type: 'text' },
  { header: 'Vto. CAE',          getValue: (r) => r.fecha_vto_cae,              type: 'date' },
  { header: 'Neto Gravado',      getValue: (r) => r.neto_gravado,               type: 'currency', numericSort: true },
  { header: 'Monto Exento',      getValue: (r) => r.monto_exento,               type: 'currency', numericSort: true },
  { header: 'IVA 27%',           getValue: (r) => r.iva_27,                     type: 'currency', numericSort: true },
  { header: 'IVA 21%',           getValue: (r) => r.iva_21,                     type: 'currency', numericSort: true },
  { header: 'IVA 10,5%',         getValue: (r) => r.iva_105,                    type: 'currency', numericSort: true },
  { header: 'IVA 5%',            getValue: (r) => r.iva_5,                      type: 'currency', numericSort: true },
  {
    header: 'IVA Total',
    getValue: (r) => {
      const d = (r.iva_27 ?? 0) + (r.iva_21 ?? 0) + (r.iva_105 ?? 0) + (r.iva_5 ?? 0) + (r.iva_25 ?? 0);
      return d > 0 ? d : (r.iva ?? null);
    },
    type: 'currency', numericSort: true,
  },
  { header: 'Perc. IIBB',        getValue: (r) => r.percepcion_ingresos_brutos, type: 'currency', numericSort: true },
  { header: 'Perc. IVA',         getValue: (r) => r.percepcion_iva,             type: 'currency', numericSort: true },
  { header: 'Imp. Internos',     getValue: (r) => r.impuestos_internos,         type: 'currency', numericSort: true },
  { header: 'Total',             getValue: (r) => r.total,                      type: 'currency', numericSort: true },
  { header: 'Ordenes de Compra', getValue: (r) => r.pdf_job_row_oc,             type: 'oc_list' },
  { header: 'Codigo Obra',       getValue: (r) => r.pdf_job_row_oc,             type: 'obra_list' },
];

// Estilos base — definidos fuera del componente para maxima persistencia
const TH_STYLE: React.CSSProperties = {
  cursor: 'pointer',
  userSelect: 'none',
  textAlign: 'center',
  verticalAlign: 'bottom',
  lineHeight: 1.3,
};

const TD_STYLE: React.CSSProperties = {
  fontSize: '0.9rem',
  textAlign: 'center',
  whiteSpace: 'nowrap',
};

// Encabezados multi-palabra: cada palabra en su propia linea
function HeaderLabel({ text }: { text: string }) {
  const words = text.split(' ');
  if (words.length === 1) return <>{text}</>;
  return (
    <>
      {words.map((w, i) => (
        <span key={i}>
          {i > 0 && <br />}
          {w}
        </span>
      ))}
    </>
  );
}

export function JobRowsTable({ rows }: JobRowsTableProps) {
  const [sortCol, setSortCol] = useState<number>(-1);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const fmtCurrency = (v: any) => {
    if (v == null) return '-';
    const n = typeof v === 'string' ? parseFloat(v) : v;
    if (isNaN(n)) return String(v);
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(n);
  };

  // Formato DD-MM-YYYY usando UTC para evitar desfase de zona horaria
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
    const obras = [...new Set(
      v.map((oc: any) => oc?.codigo_obra).filter(Boolean)
    )] as string[];
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
      let va = col.getValue(a);
      let vb = col.getValue(b);
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
    return <span style={{ marginLeft: 3 }}>{sortDir === 'asc' ? String.fromCharCode(8593) : String.fromCharCode(8595)}</span>;
  };

  if (rows.length === 0) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
        <p style={{ color: 'var(--color-text-secondary)', margin: 0 }}>
          Este proceso aun no tiene filas procesadas.
        </p>
      </div>
    );
  }

  return (
    <div className="table-wrapper">
      <table className="job-rows-table">
        <thead>
          <tr>
            {COLUMNS.map((col, i) => (
              <th key={col.header} onClick={() => handleSort(i)} style={TH_STYLE}>
                <HeaderLabel text={col.header} />{arrow(i)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, index) => {
            const classification: string = row.doc_status ?? 'ok';
            const rowBaseStyle = classification === 'failed'
              ? { backgroundColor: 'rgba(220, 53, 69, 0.12)', borderLeft: '3px solid var(--color-danger)' }
              : classification === 'warning'
              ? { backgroundColor: 'rgba(241, 185, 34, 0.18)', borderLeft: '3px solid var(--color-warning)' }
              : undefined;
            return (
              <tr key={index} style={rowBaseStyle}>
                {COLUMNS.map((col) => {
                  const cellText = fmtCell(col, row);
                  return (
                    <td
                      key={col.header}
                      style={{ ...TD_STYLE, ...col.tdStyle }}
                      title={cellText !== '-' ? cellText : undefined}
                    >
                      {cellText}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
