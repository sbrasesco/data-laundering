import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useClientJobs, DashboardFilters } from '../hooks/useClientJobs';
import { useClients } from '../hooks/useClients';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { JobStatusBadge } from '../components/pdf-jobs/JobStatusBadge';
import { PdfJob } from '../hooks/usePdfJobs';
import { formatDisplayDate } from '../utils/dateFormat';

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

  const handleClearFilters = () => {
    setFilters({});
  };

  const formatPeriod = (month: number | null, year: number | null) => {
    if (!month || !year) return '-';
    const months = [
      'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
      'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'
    ];
    return `${months[month - 1]} ${year}`;
  };

  const formatDocuments = (job: PdfJob) => {
    const total     = job.total_documents ?? 0;
    const processed = job.processed_documents ?? 0;

    if (total === 0) return '-';

    return `${processed} / ${total}`;
  };

  return (
    <div>
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        marginBottom: '2rem' 
      }}>
        <div>
          <h1>Dashboard de procesos</h1>
          <p style={{ color: 'var(--color-text-secondary)', marginTop: '0.5rem' }}>
            Resumen de actividad y procesos de la organización
          </p>
        </div>
        <button 
          onClick={() => navigate('/jobs/new')} 
          className="btn btn-success"
        >
          Nuevo proceso
        </button>
      </div>

      {/* Filtros */}
      <div className="card" style={{ marginBottom: '2rem' }}>
        <h3 style={{ marginBottom: '1.5rem', fontSize: '1.25rem' }}>Filtros</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1rem' }}>
          <div className="form-group">
            <label className="form-label">Cliente</label>
            <select
              className="form-control"
              value={filters.clientId || ''}
              onChange={handleClientChange}
              disabled={clientsLoading}
            >
              <option value="">Todos los clientes</option>
              {clients.map(client => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Fecha desde</label>
            <input
              type="date"
              className="form-control"
              value={filters.fechaDesde || ''}
              onChange={handleFechaDesdeChange}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Fecha hasta</label>
            <input
              type="date"
              className="form-control"
              value={filters.fechaHasta || ''}
              onChange={handleFechaHastaChange}
            />
          </div>
        </div>
        <div style={{ marginTop: '1rem' }}>
          <button
            onClick={handleClearFilters}
            className="btn btn-secondary"
            style={{ fontSize: '0.875rem', padding: '0.5rem 1rem' }}
          >
            Limpiar filtros
          </button>
        </div>
      </div>

      {/* Spinner solo en la primera carga (sin datos todavía) */}
      {loading && <LoadingSpinner />}
      {error && <ErrorMessage message={error} />}

      {/* Mostrar contenido si ya hay datos, aunque haya un refresh en curso */}
      {(!loading || jobs.length > 0) && !error && (
        <>
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', 
            gap: '1rem', 
            marginBottom: '2rem' 
          }}>
            <div className="card" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', fontWeight: '700', color: 'var(--color-primary)', marginBottom: '0.5rem' }}>
                {metrics.jobsCount}
              </div>
              <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>
                Total de Procesos
              </div>
            </div>

            <div className="card" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', fontWeight: '700', color: 'var(--color-primary)', marginBottom: '0.5rem' }}>
                {metrics.totalDocuments}
              </div>
              <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>
                Documentos Totales
              </div>
            </div>

            <div className="card" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', fontWeight: '700', color: 'var(--color-success)', marginBottom: '0.5rem' }}>
                {metrics.processedDocuments}
              </div>
              <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>
                Documentos Correctos
              </div>
            </div>

            <div className="card" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', fontWeight: '700', color: 'var(--color-danger)', marginBottom: '0.5rem' }}>
                {metrics.failedDocuments}
              </div>
              <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>
                Documentos Fallidos
              </div>
            </div>

            <div className="card" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', fontWeight: '700', color: 'var(--color-warning)', marginBottom: '0.5rem' }}>
                {metrics.documentsWithWarnings}
              </div>
              <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>
                Documentos con Advertencias
              </div>
            </div>

            <div className="card" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', fontWeight: '700', color: 'var(--color-danger)', marginBottom: '0.5rem' }}>
                {metrics.jobsWithError}
              </div>
              <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>
                Procesos con Error
              </div>
            </div>
          </div>

          {/* Tabla de procesos */}
          <h2 style={{ marginBottom: '1rem' }}>Procesos</h2>
          {jobs.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
              <p style={{ color: 'var(--color-text-secondary)', margin: 0 }}>
                Todavía no hay procesos para mostrar en el dashboard.
              </p>
            </div>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Fecha Proceso</th>
                    <th>Cliente</th>
                    <th>Período</th>
                    <th>Estado</th>
                    <th>Documentos</th>
                    <th>Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr key={job.id}>
                      <td>{formatDisplayDate(job.created_at)}</td>
                      <td>{job.clients?.name || '-'}</td>
                      <td>{formatPeriod(job.period_month, job.period_year)}</td>
                      <td>
                        <JobStatusBadge
                          status={job.status}
                          total_documents={job.total_documents}
                          processed_documents={job.processed_documents}
                          failed_documents={job.failed_documents}
                          has_warnings={job.has_warnings}
                        />
                      </td>
                      <td>{formatDocuments(job)}</td>
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
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

