import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useActiveClients } from '../hooks/useActiveClients';
import { createPdfJob, uploadFileToN8n } from '../lib/pdfJobHelpers';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { ErrorMessage } from '../components/ui/ErrorMessage';

export function SubirZipPage() {
  const [file, setFile] = useState<File | null>(null);
  const [clientId, setClientId] = useState<string>('');
  const [periodMonth, setPeriodMonth] = useState<number>(new Date().getMonth() + 1);
  const [periodYear, setPeriodYear] = useState<number>(new Date().getFullYear());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const { user, organizationId } = useAuth();
  const { clients, loading: clientsLoading, error: clientsError } = useActiveClients();
  const navigate = useNavigate();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setError(null);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (!file) {
      setError('Por favor seleccioná un archivo');
      return;
    }

    if (!clientId) {
      setError('Por favor seleccioná un cliente');
      return;
    }

    if (!user) {
      setError('No hay sesión activa. Por favor iniciá sesión nuevamente.');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      // 1. Crear el job en pdf_jobs (status = 'pending')
      const { data: job, error: jobError } = await createPdfJob({
        user_id: user.id,
        client_id: clientId,
        period_month: periodMonth,
        period_year: periodYear,
      });

      if (jobError || !job) {
        throw new Error(jobError || 'Error al crear el proceso');
      }

      // 2. Lanzar el webhook de n8n EN SEGUNDO PLANO
      //    NO esperamos el resultado para navegar
      const selectedClient = clients.find((c) => c.id === clientId);
      uploadFileToN8n(file, job.id, selectedClient?.name, selectedClient?.tax_id, organizationId).catch((err) => {
        // Opcional: loguear error en consola
        console.error('Error llamando a n8n', err);
      });

      // 3. Redirigir inmediatamente al Dashboard
      navigate('/dashboard');
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Error desconocido al crear el proceso');
    } finally {
      setLoading(false);
    }
  };

  // Generar años recientes (año actual y 2 años anteriores)
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 3 }, (_, i) => currentYear - i);

  const months = [
    { value: 1, label: 'Enero' },
    { value: 2, label: 'Febrero' },
    { value: 3, label: 'Marzo' },
    { value: 4, label: 'Abril' },
    { value: 5, label: 'Mayo' },
    { value: 6, label: 'Junio' },
    { value: 7, label: 'Julio' },
    { value: 8, label: 'Agosto' },
    { value: 9, label: 'Septiembre' },
    { value: 10, label: 'Octubre' },
    { value: 11, label: 'Noviembre' },
    { value: 12, label: 'Diciembre' },
  ];

  return (
    <div className="card" style={{ maxWidth: '600px', margin: '0 auto' }}>
      <h1>Crear nuevo proceso</h1>
      <p style={{ color: 'var(--color-text-secondary)', marginBottom: '2rem' }}>
        Subí un archivo ZIP o PDF con comprobantes para procesar.
      </p>

      {clientsError && <ErrorMessage message={clientsError} />}

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="client" className="form-label">
            Cliente <span style={{ color: 'var(--color-primary)' }}>*</span>
          </label>
          {clientsLoading ? (
            <div style={{ padding: '0.75rem', color: 'var(--color-text-secondary)' }}>
              Cargando clientes...
            </div>
          ) : (
            <select
              id="client"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              required
              disabled={loading || clientsLoading}
              className="form-control"
            >
              <option value="">Seleccionar cliente</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
          <div className="form-group">
            <label htmlFor="period_month" className="form-label">
              Mes <span style={{ color: 'var(--color-primary)' }}>*</span>
            </label>
            <select
              id="period_month"
              value={periodMonth}
              onChange={(e) => setPeriodMonth(Number(e.target.value))}
              required
              disabled={loading}
              className="form-control"
            >
              {months.map((month) => (
                <option key={month.value} value={month.value}>
                  {month.label}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="period_year" className="form-label">
              Año <span style={{ color: 'var(--color-primary)' }}>*</span>
            </label>
            <select
              id="period_year"
              value={periodYear}
              onChange={(e) => setPeriodYear(Number(e.target.value))}
              required
              disabled={loading}
              className="form-control"
            >
              {years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="form-group">
          <label htmlFor="file" className="form-label">
            Archivo (ZIP o PDF) <span style={{ color: 'var(--color-primary)' }}>*</span>
          </label>
          <input
            id="file"
            type="file"
            accept=".zip,.pdf"
            onChange={handleFileChange}
            disabled={loading}
            required
            className="form-control"
          />
          {file && (
            <p style={{ marginTop: '0.5rem', color: 'var(--color-text-secondary)', fontSize: '0.9rem' }}>
              Archivo seleccionado: {file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)
            </p>
          )}
        </div>

        {error && <ErrorMessage message={error} />}
        {successMessage && (
          <div className="alert alert-success">
            {successMessage}
          </div>
        )}

        <div style={{ display: 'flex', gap: '1rem' }}>
          <button
            type="submit"
            disabled={loading || !file || !clientId || clientsLoading}
            className="btn btn-success"
          >
            {loading ? 'Creando proceso...' : 'Crear proceso'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            disabled={loading}
            className="btn btn-secondary"
          >
            Cancelar
          </button>
        </div>
      </form>

      {loading && (
        <div style={{ marginTop: '2rem' }}>
          <LoadingSpinner />
        </div>
      )}
    </div>
  );
}
