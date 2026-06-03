import { useEffect } from 'react';
import { DocumentRow } from '../../hooks/useAllDocuments';
import { DOCUMENT_DETAIL_SECTIONS, formatDocumentDetailValue } from '../../lib/documentDetailFields';
import { JobStatusBadge } from '../pdf-jobs/JobStatusBadge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface DocumentDetailModalProps {
  document: DocumentRow | null;
  onClose: () => void;
}

export function DocumentDetailModal({ document: doc, onClose }: DocumentDetailModalProps) {
  useEffect(() => {
    if (!doc) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [doc, onClose]);

  return (
    <Dialog open={!!doc} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Detalle del documento</DialogTitle>
          {doc && (
            <p className="text-sm text-muted-foreground">
              {doc.numero_comprobante || 'Sin número'} · {doc.proveedor || 'Sin proveedor'}
            </p>
          )}
        </DialogHeader>

        {doc && (
          <div className="space-y-6 mt-2">
            {doc.pdf_jobs?.status && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                  Estado del proceso
                </p>
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
              <section key={section.title}>
                <h3 className="text-sm font-semibold text-foreground mb-3 border-b pb-1">{section.title}</h3>
                <dl className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(14rem, 1fr))' }}>
                  {section.fields.map((field) => (
                    <div key={field.label}>
                      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">
                        {field.label}
                      </dt>
                      <dd className="text-sm text-foreground break-words">
                        {formatDocumentDetailValue(field.getValue(doc), field.format, doc)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}

            <div className="flex justify-end pt-2 border-t">
              <Button variant="outline" onClick={onClose}>Cerrar</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
