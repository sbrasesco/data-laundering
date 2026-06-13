import { useState, useEffect, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useActiveClients } from '../hooks/useActiveClients';
import { useTenantCredits } from '../hooks/useTenantCredits';
import { createPdfJob, uploadFileToWorker, failPdfJob } from '../lib/pdfJobHelpers';
import { InsufficientCreditsModal } from '../components/ui/InsufficientCreditsModal';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function SubirZipPage() {
  const [file, setFile] = useState<File | null>(null);
  const [clientId, setClientId] = useState<string>('');
  const [periodMonth, setPeriodMonth] = useState<number>(new Date().getMonth() + 1);
  const [periodYear, setPeriodYear] = useState<number>(new Date().getFullYear());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreditsModal, setShowCreditsModal] = useState(false);
  const { user, organizationId } = useAuth();
  const { clients, loading: clientsLoading, error: clientsError } = useActiveClients();
  const { balance, loading: creditsLoading } = useTenantCredits();
  const navigate = useNavigate();

  useEffect(() => {
    if (!creditsLoading && balance === 0) {
      setShowCreditsModal(true);
    }
  }, [balance, creditsLoading]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) { setFile(e.target.files[0]); setError(null); }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (balance === 0) { setShowCreditsModal(true); return; }
    if (!file) { setError('Por favor seleccioná un archivo'); return; }
    if (!clientId) { setError('Por favor seleccioná un cliente'); return; }
    if (!user) { setError('No hay sesión activa. Por favor iniciá sesión nuevamente.'); return; }

    setLoading(true);
    setError(null);

    try {
      const { data: job, error: jobError } = await createPdfJob({ user_id: user.id, client_id: clientId, period_month: periodMonth, period_year: periodYear });
      if (jobError || !job) throw new Error(jobError || 'Error al crear el proceso');

      const selectedClient = clients.find((c) => c.id === clientId);
      uploadFileToWorker(file, job.id, selectedClient?.name, selectedClient?.tax_id, organizationId)
        .then((result) => {
          if (!result.success) {
            const isCredits = result.error?.includes('INSUFFICIENT_CREDITS') || result.error?.includes('créditos') || result.error?.includes('creditos');
            failPdfJob(job.id, result.error ?? 'Error al encolar el trabajo', isCredits ? 'credits' : 'processing');
          }
        })
        .catch((err) => { failPdfJob(job.id, err instanceof Error ? err.message : 'Error inesperado'); });

      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido al crear el proceso');
    } finally {
      setLoading(false);
    }
  };

  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 3 }, (_, i) => currentYear - i);

  const months = [
    { value: 1, label: 'Enero' }, { value: 2, label: 'Febrero' }, { value: 3, label: 'Marzo' },
    { value: 4, label: 'Abril' }, { value: 5, label: 'Mayo' }, { value: 6, label: 'Junio' },
    { value: 7, label: 'Julio' }, { value: 8, label: 'Agosto' }, { value: 9, label: 'Septiembre' },
    { value: 10, label: 'Octubre' }, { value: 11, label: 'Noviembre' }, { value: 12, label: 'Diciembre' },
  ];

  const selectCls = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">
          Crear{' '}
          <span className="inline-block px-2 py-0.5 rounded-lg" style={{ background: '#22C365', color: '#ffffff' }}>nuevo proceso</span>
        </h1>
        <p className="text-sm text-muted-foreground">Subí un ZIP, PDF o imagen (JPG, PNG) con comprobantes para procesar.</p>
      </div>

      {clientsError && <ErrorMessage message={clientsError} />}

      <Card className="max-w-xl">
        <CardHeader><CardTitle className="text-base">Datos del proceso</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="client">Cliente <span className="text-destructive">*</span></Label>
              {clientsLoading
                ? <p className="text-sm text-muted-foreground py-1">Cargando clientes...</p>
                : (
                  <select id="client" value={clientId} onChange={(e) => setClientId(e.target.value)} required disabled={loading || clientsLoading} className={selectCls}>
                    <option value="">Seleccionar cliente</option>
                    {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="period_month">Mes <span className="text-destructive">*</span></Label>
                <select id="period_month" value={periodMonth} onChange={(e) => setPeriodMonth(Number(e.target.value))} required disabled={loading} className={selectCls}>
                  {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="period_year">Año <span className="text-destructive">*</span></Label>
                <select id="period_year" value={periodYear} onChange={(e) => setPeriodYear(Number(e.target.value))} required disabled={loading} className={selectCls}>
                  {years.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="file">Archivo (ZIP, PDF, JPG, PNG) <span className="text-destructive">*</span></Label>
              <input id="file" type="file" accept=".zip,.rar,.pdf,.jpg,.jpeg,.png" onChange={handleFileChange} disabled={loading} required
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50" />
              {file && <p className="text-xs text-muted-foreground">{file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)</p>}
            </div>

            {error && <ErrorMessage message={error} />}

            <div className="flex gap-3 pt-2">
              <Button type="submit" disabled={loading || !file || !clientId || clientsLoading || balance === 0}>
                {loading ? 'Creando proceso…' : 'Crear proceso'}
              </Button>
              <Button type="button" variant="outline" onClick={() => navigate('/dashboard')} disabled={loading}>
                Cancelar
              </Button>
              {!creditsLoading && balance === 0 && (
                <button
                  type="button"
                  onClick={() => setShowCreditsModal(true)}
                  className="text-xs text-destructive hover:underline self-center ml-1"
                >
                  Sin créditos — Recargar
                </button>
              )}
            </div>
          </form>
          {loading && <div className="mt-4"><LoadingSpinner /></div>}
        </CardContent>
      </Card>

      <InsufficientCreditsModal isOpen={showCreditsModal} onClose={() => setShowCreditsModal(false)} />
    </div>
  );
}
