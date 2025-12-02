import { useNavigate } from 'react-router-dom';
import { JobStatusBadge } from './JobStatusBadge';
import { PdfJob } from '../../hooks/usePdfJobs';

interface JobListProps {
  jobs: PdfJob[];
}

export function JobList({ jobs }: JobListProps) {
  const navigate = useNavigate();

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
      'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
      'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'
    ];
    return `${months[month - 1]} ${year}`;
  };

  if (jobs.length === 0) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
        <p style={{ color: 'var(--color-text-secondary)', margin: 0 }}>
          Todavía no tenés procesos. Creá tu primer proceso.
        </p>
      </div>
    );
  }

  return (
    <div className="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Cliente</th>
            <th>Período</th>
            <th>Estado</th>
            <th>Documentos</th>
            <th>Acción</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const formatDocuments = () => {
              const total = job.total_documents ?? 0;
              const processed = job.processed_documents ?? 0;
              
              if (total === 0) {
                return '-';
              }
              
              return `${processed} / ${total}`;
            };

            return (
              <tr key={job.id}>
                <td>{formatDate(job.created_at)}</td>
                <td>{job.clients?.name || '-'}</td>
                <td>{formatPeriod(job.period_month, job.period_year)}</td>
                <td>
                  <JobStatusBadge 
                    status={job.status} 
                    total_documents={job.total_documents} 
                    processed_documents={job.processed_documents} 
                    failed_documents={job.failed_documents} 
                    has_warnings={job.has_warnings} 
                    rows_count={job.rows_count} 
                  />
                </td>
                <td>{formatDocuments()}</td>
                <td>
                  <button
                    onClick={() => navigate(`/jobs/${job.id}`)}
                    className="btn btn-primary"
                    style={{ fontSize: '0.875rem', padding: '0.5rem 1rem' }}
                  >
                    Ver detalles
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

