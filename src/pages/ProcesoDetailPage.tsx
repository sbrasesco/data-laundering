import { useParams, useNavigate } from 'react-router-dom';
import { usePdfJob } from '../hooks/usePdfJob';
import { usePdfJobRows } from '../hooks/usePdfJobRows';
import { useAuthContext } from '../contexts/AuthContext';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { Button } from '@/components/ui/button';
import { JobDetailHeader } from '../components/pdf-jobs/JobDetailHeader';
import { JobDiscrepancyNotice } from '../components/pdf-jobs/JobDiscrepancyNotice';
import { JobDocumentsSection } from '../components/pdf-jobs/JobDocumentsSection';
import { JobRowsTable } from '../components/pdf-jobs/JobRowsTable';

export function ProcesoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { organizationId } = useAuthContext();
  const { job, loading: jobLoading, error: jobError } = usePdfJob(id || '');
  const { rows, loading: rowsLoading, error: rowsError, refetch } = usePdfJobRows(id || '');

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

      <JobDiscrepancyNotice job={job} />

      {rowsError && <ErrorMessage message={rowsError} />}

      <JobDocumentsSection
        rows={rows}
        jobId={id || ''}
        orgId={organizationId || ''}
        onRowUpdated={refetch}
      />

      <div className="space-y-3">
        <h2 className="text-lg font-bold tracking-tight">
          Filas{' '}
          <span className="inline-block px-1.5 py-0.5 rounded-md text-base" style={{ background: '#22C365', color: '#ffffff' }}>procesadas</span>
        </h2>
        <JobRowsTable
          rows={rows}
          jobId={id || ''}
          orgId={organizationId || ''}
          onRowUpdated={refetch}
        />
      </div>
    </div>
  );
}
