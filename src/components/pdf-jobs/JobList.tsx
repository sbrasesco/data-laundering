import { useNavigate } from 'react-router-dom';
import { PdfJob } from '../../hooks/usePdfJobs';
import { getJobStatusLabel, getJobStatusClass } from '../../utils/status';

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
            // Lógica derivada para mostrar "Procesando" mientras no se hayan resuelto todos los documentos
            const total = job.total_documents ?? 0;
            const processed = job.processed_documents ?? 0;
            const failed = job.failed_documents ?? 0;

            const isProcessing =
              job.status === 'pending' ||
              job.status === 'processing' ||
              total === 0 ||
              processed + failed < total;

            // Mapear done_with_warnings a done para la visualización
            const computedStatus =
              job.status === 'done_with_warnings' ? 'done' : job.status;

            const displayLabel = isProcessing
              ? 'Procesando'
              : getJobStatusLabel(computedStatus);

            const displayClass = isProcessing
              ? getJobStatusClass('pending') // pill gris
              : getJobStatusClass(computedStatus);

            return (
              <tr key={job.id}>
                <td>{formatDate(job.created_at)}</td>
                <td>{job.clients?.name || '-'}</td>
                <td>{formatPeriod(job.period_month, job.period_year)}</td>
                <td>
                  <span
                    className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${displayClass}`}
                  >
                    {displayLabel}
                  </span>
                </td>
                <td>
                  {job.total_documents && job.total_documents > 0
                    ? `${job.processed_documents ?? 0} / ${job.total_documents}`
                    : '-'}
                </td>
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

