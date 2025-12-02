import { JobStatusBadge } from './JobStatusBadge';
import { PdfJobDetail } from '../../hooks/usePdfJob';

interface JobDetailHeaderProps {
  job: PdfJobDetail;
}

export function JobDetailHeader({ job }: JobDetailHeaderProps) {
  const getShortId = (id: string) => {
    return id.substring(0, 8);
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('es-AR', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatPeriod = (month: number | null, year: number | null) => {
    if (!month || !year) return '-';
    const months = [
      'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
    ];
    return `${months[month - 1]} ${year}`;
  };

  return (
    <div className="card" style={{ marginBottom: '2rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>Proceso {getShortId(job.id)}</h1>
        <JobStatusBadge 
          status={job.status} 
          total_documents={job.total_documents} 
          processed_documents={job.processed_documents} 
          failed_documents={job.failed_documents} 
          has_warnings={job.has_warnings} 
          rows_count={job.rows_count} 
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1rem' }}>
        <div>
          <strong style={{ display: 'block', marginBottom: '0.25rem', color: 'var(--color-text-secondary)' }}>
            Cliente
          </strong>
          <span>{job.clients?.name || '-'}</span>
        </div>
        <div>
          <strong style={{ display: 'block', marginBottom: '0.25rem', color: 'var(--color-text-secondary)' }}>
            Período
          </strong>
          <span>{formatPeriod(job.period_month, job.period_year)}</span>
        </div>
        <div>
          <strong style={{ display: 'block', marginBottom: '0.25rem', color: 'var(--color-text-secondary)' }}>
            Fecha de creación
          </strong>
          <span>{formatDate(job.created_at)}</span>
        </div>
        {job.finished_at && (
          <div>
            <strong style={{ display: 'block', marginBottom: '0.25rem', color: 'var(--color-text-secondary)' }}>
              Fecha de finalización
            </strong>
            <span>{formatDate(job.finished_at)}</span>
          </div>
        )}
        <div>
          <strong style={{ display: 'block', marginBottom: '0.25rem', color: 'var(--color-text-secondary)' }}>
            Total de documentos
          </strong>
          <span>{job.total_documents ?? 0}</span>
        </div>
        <div>
          <strong style={{ display: 'block', marginBottom: '0.25rem', color: 'var(--color-text-secondary)' }}>
            Procesados
          </strong>
          <span>{job.processed_documents ?? 0}</span>
        </div>
        <div>
          <strong style={{ display: 'block', marginBottom: '0.25rem', color: 'var(--color-text-secondary)' }}>
            Fallidos
          </strong>
          <span>{job.failed_documents ?? 0}</span>
        </div>
      </div>

      {job.has_warnings && (
        <div className="alert alert-warning" style={{ marginBottom: '1rem' }}>
          <strong style={{ display: 'block', marginBottom: '0.5rem' }}>Advertencia:</strong>
          <span>Este proceso se completó con advertencias. Algunos documentos no pudieron procesarse correctamente.</span>
        </div>
      )}

      {job.error_message && (
        <div className="alert alert-danger">
          <strong style={{ display: 'block', marginBottom: '0.5rem' }}>Error:</strong>
          <span>{job.error_message}</span>
        </div>
      )}
    </div>
  );
}

