import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useClientJobs, DashboardFilters } from '../hooks/useClientJobs';
import { useClients } from '../hooks/useClients';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { JobStatusBadge } from '../components/pdf-jobs/JobStatusBadge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { PdfJob } from '../hooks/usePdfJobs';
import { formatDisplayDate } from '../utils/dateFormat';

const SOURCE_LABELS: Record<string, string> = {
  integration_drive: 'Drive',
  ftp:               'FTP',
  sftp:              'SFTP',
  firebase_storage:  'Firebase',
};

function InputSourceBadge({ source }: { source: PdfJob['input_source'] }) {
  if (!source || source === 'frontend_upload') return <span className="text-xs text-muted-foreground">Manual</span>;
  return <Badge variant="outline" className="text-xs">{SOURCE_LABELS[source] ?? source}</Badge>;
}

function MetricCard({ value, label }: { value: number; label: string }) {
  return (
    <Card>
      <CardContent className="pt-6 text-center">
        <div className="text-3xl font-bold tracking-tight text-foreground mb-1">{value}</div>
        <div className="text-sm text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}

export function ClientDashboardPage() {
  const navigate = useNavigate();
  const { clients, loading: clientsLoading } = useClients();
  const [filters, setFilters] = useState<DashboardFilters>({});

  const { jobs, loading, error, metrics } = useClientJobs(filters);

  const handleClientChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setFilters(prev => ({ ...prev, clientId: e.target.value || undefined }));
  };

  const handleFechaDesdeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFilters(prev => ({ ...prev, fechaDesde: e.target.value || undefined }));
  };

  const handleFechaHastaChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFilters(prev => ({ ...prev, fechaHasta: e.target.value || undefined }));
  };

  const handleClearFilters = () => setFilters({});

  const formatPeriod = (month: number | null, year: number | null) => {
    if (!month || !year) return '-';
    const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    return `${months[month - 1]} ${year}`;
  };

  const formatDocuments = (job: PdfJob) => {
    const total     = job.total_documents ?? 0;
    const processed = job.processed_documents ?? 0;
    if (total === 0) return '-';
    return `${processed} / ${total}`;
  };

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard de procesos</h1>
          <p className="text-sm text-muted-foreground">
            Resumen de actividad y procesos de la organización
          </p>
        </div>
        <Button onClick={() => navigate('/jobs/new')}>+ Nuevo proceso</Button>
      </div>

      {/* Filtros */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filtros</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <div className="flex flex-col gap-1.5">
              <Label>Cliente</Label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                value={filters.clientId || ''}
                onChange={handleClientChange}
                disabled={clientsLoading}
              >
                <option value="">Todos los clientes</option>
                {clients.map(client => (
                  <option key={client.id} value={client.id}>{client.name}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Fecha desde</Label>
              <Input type="date" value={filters.fechaDesde || ''} onChange={handleFechaDesdeChange} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Fecha hasta</Label>
              <Input type="date" value={filters.fechaHasta || ''} onChange={handleFechaHastaChange} />
            </div>
          </div>
          <div className="mt-4">
            <Button variant="outline" size="sm" onClick={handleClearFilters}>
              Limpiar filtros
            </Button>
          </div>
        </CardContent>
      </Card>

      {loading && <LoadingSpinner />}
      {error && <ErrorMessage message={error} />}

      {(!loading || jobs.length > 0) && !error && (
        <>
          {/* Métricas */}
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <MetricCard value={metrics.jobsCount}             label="Total de procesos" />
            <MetricCard value={metrics.totalDocuments}        label="Documentos totales" />
            <MetricCard value={metrics.processedDocuments}    label="Documentos correctos" />
            <MetricCard value={metrics.failedDocuments}       label="Documentos fallidos" />
            <MetricCard value={metrics.documentsWithWarnings} label="Con advertencias" />
            <MetricCard value={metrics.jobsWithError}         label="Procesos con error" />
          </div>

          {/* Tabla de procesos */}
          <div className="space-y-3">
            <h2 className="text-lg font-semibold tracking-tight">Procesos</h2>

            {jobs.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <p className="text-sm text-muted-foreground">
                    Todavía no hay procesos para mostrar en el dashboard.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Fecha proceso</TableHead>
                      <TableHead>Cliente</TableHead>
                      <TableHead>Origen</TableHead>
                      <TableHead>Período</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead>Documentos</TableHead>
                      <TableHead>Acción</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobs.map((job) => (
                      <TableRow key={job.id}>
                        <TableCell className="text-sm">{formatDisplayDate(job.created_at)}</TableCell>
                        <TableCell className="text-sm">{job.clients?.name || '-'}</TableCell>
                        <TableCell><InputSourceBadge source={job.input_source} /></TableCell>
                        <TableCell className="text-sm text-muted-foreground">{formatPeriod(job.period_month, job.period_year)}</TableCell>
                        <TableCell>
                          <JobStatusBadge
                            status={job.status}
                            total_documents={job.total_documents}
                            processed_documents={job.processed_documents}
                            failed_documents={job.failed_documents}
                            has_warnings={job.has_warnings}
                          />
                        </TableCell>
                        <TableCell className="text-sm tabular-nums">{formatDocuments(job)}</TableCell>
                        <TableCell>
                          <Button size="sm" onClick={() => navigate(`/jobs/${job.id}`)}>
                            Ver detalles
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  );
}
