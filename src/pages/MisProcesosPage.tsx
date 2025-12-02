import { useNavigate } from 'react-router-dom';
import { usePdfJobs } from '../hooks/usePdfJobs';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { JobList } from '../components/pdf-jobs/JobList';

export function MisProcesosPage() {
  const { jobs, loading, error } = usePdfJobs();
  const navigate = useNavigate();

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h1>Mis Procesos</h1>
        <button onClick={() => navigate('/jobs/new')} className="btn btn-success">
          Nuevo proceso
        </button>
      </div>

      {loading && <LoadingSpinner />}
      {error && <ErrorMessage message={error} />}
      {!loading && !error && <JobList jobs={jobs} />}
    </div>
  );
}

