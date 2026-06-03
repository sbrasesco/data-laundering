import { useNavigate } from 'react-router-dom';
import { usePdfJobs } from '../hooks/usePdfJobs';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { JobList } from '../components/pdf-jobs/JobList';
import { Button } from '../components/ui/button';

export function MisProcesosPage() {
  const { jobs, loading, error } = usePdfJobs();
  const navigate = useNavigate();

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Mis Procesos</h1>
          <p className="text-sm text-muted-foreground">
            Historial de todos tus procesos de extracción.
          </p>
        </div>
        <Button onClick={() => navigate('/jobs/new')}>Nuevo proceso</Button>
      </div>

      {loading && <LoadingSpinner />}
      {error && <ErrorMessage message={error} />}
      {!loading && !error && <JobList jobs={jobs} />}
    </div>
  );
}
