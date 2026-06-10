import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePdfJobs } from '../hooks/usePdfJobs';
import { useClients } from '../hooks/useClients';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { JobList } from '../components/pdf-jobs/JobList';
import { Button } from '../components/ui/button';
import { Label } from '../components/ui/label';

export function MisProcesosPage() {
  const { jobs, loading, error } = usePdfJobs();
  const { clients } = useClients();
  const navigate = useNavigate();
  const [selectedClientId, setSelectedClientId] = useState('');

  const filteredJobs = selectedClientId
    ? jobs.filter(j => j.client_id === selectedClientId)
    : jobs;

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

      <div className="flex items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label>Cliente</Label>
          <select
            className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={selectedClientId}
            onChange={e => setSelectedClientId(e.target.value)}
          >
            <option value="">Todos los clientes</option>
            {clients.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        {selectedClientId && (
          <Button variant="outline" size="sm" onClick={() => setSelectedClientId('')}>
            Limpiar
          </Button>
        )}
      </div>

      {loading && <LoadingSpinner />}
      {error && <ErrorMessage message={error} />}
      {!loading && !error && <JobList jobs={filteredJobs} />}
    </div>
  );
}
