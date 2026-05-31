import { useMemo, useState } from 'react';
import { DocumentRow } from '../../hooks/useAllDocuments';
import { JobStatusBadge } from '../pdf-jobs/JobStatusBadge';
import { DocumentDetailModal } from './DocumentDetailModal';
import { formatDisplayDate } from '../../utils/dateFormat';

interface DocumentsTableProps {
  documents: DocumentRow[];
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
  { id: 'fecha',     header: 'Fecha',          className: 'doc-table-date',      sortable: true,  getVal: (d) => d.fecha },
  { id: 'tipo',      header: 'Tipo',                                              sortable: true,  getVal: (d) => d._row_type === 'oc' ? 'OC' : (d.tipo_documento || '') },
  { id: 'proveedor', header: 'Proveedor',       className: 'doc-table-proveedor', sortable: true,  getVal: (d) => d.proveedor },
  { id: 'cuit',      header: 'CUIT',            className: 'doc-table-cuit',      sortable: true,  getVal: (d) => d.cuit },
  { id: 'receptor',  header: 'Receptor',        className: 'doc-table-receptor',  sortable: true,  getVal: (d) => d._row_type === 'oc' ? null : d.receptor_nombre },
  { id: 'numero',    header: 'Número / OC',     className: 'doc-table-numero',    sortable: true,  getVal: (d) => d._row_type === 'oc' ? (d.numero_oc || null) : d.numero_comprobante },
  { id: 'obra',      header: 'Cód. Obra',                                         sortable: true,  getVal: (d) => d._row_type === 'oc' ? (d.codigo_obra || null) : null },
  { id: 'moneda',    header: 'Moneda',                                            sortable: true,  getVal: (d) => d._row_type === 'oc' ? null : (d.es_moneda_usd ? 'USD' : 'ARS') },
  { id: 'neto',      header: 'Neto',            className: 'doc-table-neto',      sortable: true,  getVal: (d) => d._row_type === 'oc' ? null : d.neto_gravado },
  { id: 'iva',       header: 'IVA',             className: 'doc-table-iva',       sortable: true,  getVal: (d) => d._row_type === 'oc' ? null : d.iva },
  { id: 'total',     header: 'Total',                                             sortable: true,  getVal: (d) => d._row_type === 'oc' ? null : d.total },
  { id: 'estado',    header: 'Estado Proceso',                                    sortable: true,  getVal: (d) => d.pdf_jobs?.status || null },
  { id: 'accion',    header: 'Acción',                                            sortable: false, getVal: () => null },
];

export function DocumentsTable({ documents }: DocumentsTableProps) {
  const [selectedDoc, setSelectedDoc] = useState<DocumentRow | null>(null);
  const [sortCol, setSortCol] = useState<string>('fecha');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const fmtCurrency = (v: any) => {
    if (v == null) return '-';
    const n = typeof v === 'string' ? parseFloat(v) : v;
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
      if (typeof va === 'number' && typeof vb === 'number') {
        cmp = va - vb;
      } else {
        cmp = String(va).localeCompare(String(vb), 'es', { numeric: true });
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [documents, sortCol, sortDir]);

  const arrow = (id: string) => {
    if (sortCol !== id) return <span style={{ opacity: 0.3, marginLeft: 4 }}>↕</span>;
    return <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  const thStyle = (sortable: boolean): React.CSSProperties => ({
    cursor: sortable ? 'pointer' : 'default',
    userSelect: 'none',
    whiteSpace: 'nowrap',
  });

  const getMonedaBadge = (row: DocumentRow) => {
    if (row._row_type === 'oc') return <span className="badge" style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }}>-</span>;
    if (row.es_moneda_usd) return <span className="badge badge-info">USD</span>;
    return <span className="badge badge-success">ARS</span>;
  };

  if (documents.length === 0) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
        <p style={{ color: 'var(--color-text-secondary)', margin: 0 }}>No se encontraron documentos con estos filtros.</p>
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
        .sort-th:hover { background-color: var(--color-bg-tertiary); }
      `}</style>
      <div className="table-wrapper" style={{ overflowX: 'auto' }}>
        <table className="documents-table">
          <thead>
            <tr>
              {COLS.map(col => (
                <th
                  key={col.id}
                  className={[col.className || '', col.sortable ? 'sort-th' : ''].filter(Boolean).join(' ')}
                  style={thStyle(col.sortable)}
                  onClick={() => handleSort(col.id, col.sortable)}
                >
                  {col.header}{col.sortable && arrow(col.id)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((doc) => {
              const isOC = doc._row_type === 'oc';
              return (
                <tr key={doc.id} className={isOC ? 'oc-row' : ''}>
                  <td className="doc-table-date">{formatDisplayDate(doc.fecha)}</td>
                  <td>
                    {isOC ? (
                      <span className="badge" style={{ background: 'rgba(99,102,241,0.15)', color: '#6366f1', fontWeight: 600 }}>OC</span>
                    ) : (
                      <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>{doc.tipo_documento || 'Comprobante'}</span>
                    )}
                  </td>
                  <td className="doc-table-proveedor">{doc.proveedor || '-'}</td>
                  <td className="doc-table-cuit">{doc.cuit || '-'}</td>
                  <td className="doc-table-receptor">{isOC ? '-' : (doc.receptor_nombre || '-')}</td>
                  <td className="doc-table-numero">
                    {isOC
                      ? <span style={{ fontWeight: 600 }}>{doc.numero_oc || '-'}</span>
                      : (doc.numero_comprobante || '-')
                    }
                  </td>
                  <td>
                    {isOC && doc.codigo_obra
                      ? <span style={{ fontWeight: 600, color: '#6366f1' }}>{doc.codigo_obra}</span>
                      : <span style={{ color: 'var(--color-text-secondary)' }}>-</span>
                    }
                  </td>
                  <td>{getMonedaBadge(doc)}</td>
                  <td className="doc-table-neto">{isOC ? '-' : fmtCurrency(doc.neto_gravado)}</td>
                  <td className="doc-table-iva">{isOC ? '-' : fmtCurrency(doc.iva)}</td>
                  <td style={{ fontWeight: 600 }}>{isOC ? '-' : fmtCurrency(doc.total)}</td>
                  <td>
                    {doc.pdf_jobs?.status && (
                      <JobStatusBadge
                        status={doc.pdf_jobs.status}
                        total_documents={doc.pdf_jobs.total_documents}
                        processed_documents={doc.pdf_jobs.processed_documents}
                        failed_documents={doc.pdf_jobs.failed_documents}
                        has_warnings={doc.pdf_jobs.has_warnings}
                        rows_count={doc.pdf_jobs.rows_count}
                      />
                    )}
                  </td>
                  <td>
                    {isOC ? (
                      <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>{doc.nombre_adjunto || '-'}</span>
                    ) : (
                      <button type="button" onClick={() => setSelectedDoc(doc)} className="btn btn-primary" style={{ fontSize: '0.875rem', padding: '0.5rem 1rem' }}>
                        Ver documento
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <DocumentDetailModal document={selectedDoc} onClose={() => setSelectedDoc(null)} />
    </div>
  );
}
