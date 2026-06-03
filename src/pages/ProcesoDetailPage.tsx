import { useParams, useNavigate } from 'react-router-dom';
import { usePdfJob } from '../hooks/usePdfJob';
import { usePdfJobRows } from '../hooks/usePdfJobRows';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { Button } from '@/components/ui/button';
import { JobDetailHeader } from '../components/pdf-jobs/JobDetailHeader';
import { JobRowsTable } from '../components/pdf-jobs/JobRowsTable';

export function ProcesoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { job, loading: jobLoading, error: jobError } = usePdfJob(id || '');
  const { rows, loading: rowsLoading, error: rowsError } = usePdfJobRows(id || '');

  if (jobLoading || rowsLoading) return <LoadingSpinner />;

  if (jobError) {
    return (
      <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-4">
        <ErrorMessage message={jobError} />
        <Button variant="outline" onClick={() => navigate('/dashboard')}>← Volver al Dashboard</Button>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-4">
        <ErrorMessage message="Proceso no encontrado" />
        <Button variant="outline" onClick={() => navigate('/dashboard')}>← Volver al Dashboard</Button>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <Button variant="outline" onClick={() => navigate('/dashboard')}>← Volver al Dashboard</Button>

      <JobDetailHeader job={job} />

      {rowsError && <ErrorMessage message={rowsError} />}

      <div className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Filas procesadas</h2>
        <JobRowsTable rows={rows} />
      </div>
    </div>
  );
}
