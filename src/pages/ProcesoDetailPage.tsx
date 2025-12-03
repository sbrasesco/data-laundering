import { useParams, useNavigate } from 'react-router-dom';
import { usePdfJob } from '../hooks/usePdfJob';
import { usePdfJobRows } from '../hooks/usePdfJobRows';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { JobDetailHeader } from '../components/pdf-jobs/JobDetailHeader';
import { JobRowsTable } from '../components/pdf-jobs/JobRowsTable';

export function ProcesoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { job, loading: jobLoading, error: jobError } = usePdfJob(id || '');
  const { rows, loading: rowsLoading, error: rowsError } = usePdfJobRows(id || '');

  if (jobLoading || rowsLoading) {
    return <LoadingSpinner />;
  }

  if (jobError) {
    return (
      <div>
        <ErrorMessage message={jobError} />
        <button onClick={() => navigate('/dashboard')} className="btn btn-secondary" style={{ marginTop: '1rem' }}>
          ← Volver al Dashboard
        </button>
      </div>
    );
  }

  if (!job) {
    return (
      <div>
        <ErrorMessage message="Proceso no encontrado" />
        <button onClick={() => navigate('/dashboard')} className="btn btn-secondary" style={{ marginTop: '1rem' }}>
          ← Volver al Dashboard
        </button>
      </div>
    );
  }

  return (
    <div>
      <button onClick={() => navigate('/dashboard')} className="btn btn-secondary" style={{ marginBottom: '2rem' }}>
        ← Volver al Dashboard
      </button>

      <JobDetailHeader job={job} />

      {rowsError && <ErrorMessage message={rowsError} />}

      <h2 style={{ marginTop: '2rem', marginBottom: '1rem' }}>Filas procesadas</h2>
      <JobRowsTable rows={rows} />
    </div>
  );
}

