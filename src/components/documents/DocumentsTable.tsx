import { useNavigate } from 'react-router-dom';
import { DocumentRow } from '../../hooks/useAllDocuments';
import { JobStatusBadge } from '../pdf-jobs/JobStatusBadge';

interface DocumentsTableProps {
  documents: DocumentRow[];
}

export function DocumentsTable({ documents }: DocumentsTableProps) {
  const navigate = useNavigate();

  const formatCurrency = (value: any): string => {
    if (value === null || value === undefined) {
      return '-';
    }
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(num)) return String(value);
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
    }).format(num);
  };

  const formatDate = (value: any): string => {
    if (value === null || value === undefined) {
      return '-';
    }
    try {
      const date = new Date(value);
      if (isNaN(date.getTime())) return String(value);
      return date.toLocaleDateString('es-AR', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return String(value);
    }
  };

  const getMonedaBadge = (row: DocumentRow) => {
    if (row.es_moneda_usd) {
      return <span className="badge badge-info">USD</span>;
    }
    if (row.es_moneda_ars || !row.es_moneda_usd) {
      return <span className="badge badge-success">ARS</span>;
    }
    return <span className="badge">{row.moneda || '-'}</span>;
  };

  if (documents.length === 0) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
        <p style={{ color: 'var(--color-text-secondary)', margin: 0 }}>
          No se encontraron documentos con estos filtros.
        </p>
      </div>
    );
  }

  return (
    <>
      <style>{`
        @media (max-width: 1200px) {
          .doc-table-cuit-proveedor,
          .doc-table-receptor,
          .doc-table-neto,
          .doc-table-iva {
            display: none;
          }
        }
        @media (max-width: 768px) {
          .doc-table-cuit-proveedor,
          .doc-table-receptor,
          .doc-table-neto,
          .doc-table-iva,
          .doc-table-numero,
          .doc-table-proveedor {
            display: none;
          }
        }
      `}</style>
      <div className="table-wrapper" style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Fecha Comprobante</th>
              <th>Cliente</th>
              <th className="doc-table-proveedor">Proveedor</th>
              <th className="doc-table-cuit-proveedor">CUIT Proveedor</th>
              <th className="doc-table-receptor">Receptor</th>
              <th className="doc-table-numero">Número Comprobante</th>
              <th>Moneda</th>
              <th className="doc-table-neto">Neto</th>
              <th className="doc-table-iva">IVA</th>
              <th>Total</th>
              <th>Estado Proceso</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.id}>
                <td>{formatDate(doc.fecha)}</td>
                <td>{doc.clients?.name || '-'}</td>
                <td className="doc-table-proveedor">{doc.proveedor || '-'}</td>
                <td className="doc-table-cuit-proveedor">{doc.cuit || '-'}</td>
                <td className="doc-table-receptor">{doc.receptor_nombre || '-'}</td>
                <td className="doc-table-numero">{doc.numero_comprobante || '-'}</td>
                <td>{getMonedaBadge(doc)}</td>
                <td className="doc-table-neto">{formatCurrency(doc.neto_gravado)}</td>
                <td className="doc-table-iva">{formatCurrency(doc.iva)}</td>
                <td style={{ fontWeight: '600', color: 'var(--color-text-primary)' }}>
                  {formatCurrency(doc.total)}
                </td>
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
                  <button
                    onClick={() => navigate(`/jobs/${doc.job_id}`)}
                    className="btn btn-primary"
                    style={{ fontSize: '0.875rem', padding: '0.5rem 1rem' }}
                  >
                    Ver proceso
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

