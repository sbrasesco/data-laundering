import { useEffect } from 'react';
import { DocumentRow } from '../../hooks/useAllDocuments';
import {
  DOCUMENT_DETAIL_SECTIONS,
  formatDocumentDetailValue,
} from '../../lib/documentDetailFields';
import { JobStatusBadge } from '../pdf-jobs/JobStatusBadge';

interface DocumentDetailModalProps {
  document: DocumentRow | null;
  onClose: () => void;
}

export function DocumentDetailModal({ document: doc, onClose }: DocumentDetailModalProps) {
  useEffect(() => {
    if (!doc) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [doc, onClose]);

  if (!doc) return null;

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="document-detail-title"
      onClick={onClose}
    >
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 id="document-detail-title" style={{ marginBottom: '0.25rem' }}>
              Detalle del documento
            </h2>
            <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--color-text-secondary)' }}>
              {doc.numero_comprobante || 'Sin número'} · {doc.proveedor || 'Sin proveedor'}
            </p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>

        <div className="modal-body">
          {doc.pdf_jobs?.status && (
            <div style={{ marginBottom: '1.5rem' }}>
              <span
                style={{
                  display: 'block',
                  marginBottom: '0.5rem',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  color: 'var(--color-text-secondary)',
                }}
              >
                Estado del proceso
              </span>
              <JobStatusBadge
                status={doc.pdf_jobs.status}
                total_documents={doc.pdf_jobs.total_documents}
                processed_documents={doc.pdf_jobs.processed_documents}
                failed_documents={doc.pdf_jobs.failed_documents}
                has_warnings={doc.pdf_jobs.has_warnings}
                rows_count={doc.pdf_jobs.rows_count}
              />
            </div>
          )}

          {DOCUMENT_DETAIL_SECTIONS.map((section) => (
            <section key={section.title} className="document-detail-section">
              <h3>{section.title}</h3>
              <dl className="document-detail-grid">
                {section.fields.map((field) => (
                  <div key={field.label} className="document-detail-item">
                    <dt>{field.label}</dt>
                    <dd>{formatDocumentDetailValue(field.getValue(doc), field.format, doc)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
