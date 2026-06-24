import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePdfJobs } from '../hooks/usePdfJobs';
import { useClients } from '../hooks/useClients';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { JobList } from '../components/pdf-jobs/JobList';
import { Button } from '../components/ui/button';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

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
          <h1 className="text-2xl font-bold tracking-tight">
            Mis{' '}
            <span className="inline-block px-2 py-0.5 rounded-lg" style={{ background: '#FED210', color: '#000000' }}>Procesos</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Historial de todos tus procesos de extracción.
          </p>
        </div>
        <Button onClick={() => navigate('/jobs/new')}>Nuevo proceso</Button>
      </div>

      <div className="flex items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label>Cliente</Label>
          <Select value={selectedClientId || '__all__'} onValueChange={v => setSelectedClientId(v === '__all__' ? '' : v)}>
            <SelectTrigger className="h-9 min-w-[220px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Todos los clientes</SelectItem>
              {clients.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
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
