import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { Switch } from '../components/ui/Switch';
import { AlertTriangle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useClientJobs, DashboardFilters } from '../hooks/useClientJobs';
import { useClients } from '../hooks/useClients';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { JobStatusBadge } from '../components/pdf-jobs/JobStatusBadge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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

function MetricCard({ value, label, accent = '#22C365' }: { value: number; label: string; accent?: string }) {
  return (
    <Card className="overflow-hidden h-full">
      <div className="h-1.5 w-full" style={{ background: accent }} />
      <CardContent className="pt-4 pb-5 text-center">
        <div className="text-3xl font-bold tracking-tight text-foreground mb-1 font-lora">{value}</div>
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</div>
      </CardContent>
    </Card>
  );
}

// Duración del proceso = finished_at - created_at (datos ya en pdf_jobs). '—' si no finalizó.
function formatDuration(createdAt?: string | null, finishedAt?: string | null): string {
  if (!createdAt || !finishedAt) return '—';
  const ms = new Date(finishedAt).getTime() - new Date(createdAt).getTime();
  if (!isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  return `${m}m ${totalSec % 60}s`;
}

// Tiempo acumulado (puede ser horas/días): muestra las 2 unidades más significativas.
function formatExecTotal(ms: number): string {
  if (!ms || ms <= 0) return '0s';
  const totalSec = Math.round(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// Promedio de ejecución por documento = tiempo total / documentos totales.
function formatAvgPerDoc(totalMs: number, docs: number): string {
  if (!docs || docs <= 0 || !totalMs || totalMs <= 0) return '—';
  const avgSec = (totalMs / docs) / 1000;
  return avgSec < 10 ? `${avgSec.toFixed(1)}s` : `${Math.round(avgSec)}s`;
}

// % de efectividad de extracción = promedio de confidence_score (0..1) del OCR/IA. '—' si no hay datos.
function formatEffectiveness(avg: number | null): string {
  if (avg == null) return '—';
  return `${(avg * 100).toFixed(1).replace('.', ',')}%`;
}

interface PriceFeature { key: string; label: string; cost: number; }
interface PricePolling { label: string; cost: number; }
interface PriceBreakdown {
  base_price: number;
  features: PriceFeature[];
  polling: PricePolling | null;
  total_per_doc: number;
}

interface DashIntegration { id: string; integration_type: string; is_active: boolean; }
const INTEGRATION_LABELS: Record<string, string> = {
  google_drive: 'Google Drive', supabase_storage: 'Supabase Storage',
  firebase_storage: 'Firebase Storage', ftp: 'FTP', sftp: 'SFTP',
};

export function ClientDashboardPage() {
  const navigate = useNavigate();
  const { clients, loading: clientsLoading } = useClients();
  const [filters, setFilters] = useState<DashboardFilters>({});

  const { jobs, loading, error, metrics, page, setPage, totalPages, totalJobs, systemAvgConfidence } = useClientJobs(filters);

  const [priceBreakdown, setPriceBreakdown] = useState<PriceBreakdown | null>(null);
  const [integrations, setIntegrations] = useState<DashIntegration[]>([]);
  const [togglingIntg, setTogglingIntg] = useState<string | null>(null);

  // Costo por documento + integraciones del tenant (para los switches). El precio (get_price_breakdown)
  // y el poller respetan is_active, así que togglear cambia ambos. Se recarga tras cada toggle.
  const loadCostData = useCallback(async () => {
    const [pb, ints] = await Promise.all([
      supabase.rpc('get_price_breakdown'),
      supabase.rpc('get_my_integrations'),
    ]);
    if (!pb.error && pb.data) setPriceBreakdown(pb.data as PriceBreakdown);
    if (!ints.error && Array.isArray(ints.data)) {
      setIntegrations((ints.data as any[]).map((i) => ({
        id: i.id, integration_type: i.integration_type, is_active: i.is_active,
      })));
    }
  }, []);

  useEffect(() => { loadCostData(); }, [loadCostData]);

  const handleToggleIntegration = async (intg: DashIntegration) => {
    setTogglingIntg(intg.id);
    try {
      const { error: e } = await supabase.rpc('set_integration_active', {
        p_integration_id: intg.id, p_active: !intg.is_active,
      });
      if (!e) await loadCostData();
    } finally {
      setTogglingIntg(null);
    }
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

  const correctedBadge = (job: PdfJob) => {
    const n = job.corrected_documents ?? 0;
    if (n === 0) return null;
    return (
      <span className="ml-1.5 inline-flex items-center rounded-full bg-[#A347D1]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#6b21a8] ring-1 ring-inset ring-[#A347D1]/30">
        {n} corr.
      </span>
    );
  };

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            Dashboard{' '}
            <span className="inline-block px-2 py-0.5 rounded-lg" style={{ background: '#FED210', color: '#000000' }}>de procesos</span>
          </h1>
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
              <Select
                value={filters.clientId || '__all__'}
                onValueChange={v => setFilters(prev => ({ ...prev, clientId: v === '__all__' ? undefined : v }))}
                disabled={clientsLoading}
              >
                <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Todos los clientes</SelectItem>
                  {clients.map(client => (
                    <SelectItem key={client.id} value={client.id}>{client.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
          {/* Métricas — 3 columnas: Procesos (índice), Performance (vacío), a definir (vacío).
              Solo UI/reordenamiento; los datos (metrics) se traen igual que antes. */}
          <div className="grid gap-4 lg:grid-cols-3">
            {/* Card 1 · Procesos — estilo índice (label · · · número) */}
            <Card className="overflow-hidden h-full">
              <div className="h-1.5 w-full" style={{ background: '#22C365' }} />
              <CardContent className="pt-4 pb-5">
                <h3 className="font-sugar text-2xl text-foreground mb-3 text-center">Documentos</h3>
                <ul className="space-y-2.5">
                  {[
                    { label: 'Documentos totales',     value: metrics.totalDocuments,        accent: '#22C365' },
                    { label: 'Correctos',              value: metrics.processedDocuments,    accent: '#22C365' },
                    { label: 'Fallidos',               value: metrics.failedDocuments,       accent: '#e11d48' },
                    { label: 'Con advertencias',       value: metrics.documentsWithWarnings, accent: '#FED210' },
                    { label: 'Corregidos manualmente', value: metrics.correctedDocuments,    accent: '#A347D1' },
                    { label: 'Duplicados',             value: metrics.duplicateDocuments,    accent: '#ea580c' },
                  ].map((row) => (
                    <li key={row.label} className="flex items-baseline gap-2">
                      <span className="flex items-center gap-2 shrink-0">
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: row.accent }} />
                        <span className="text-sm text-foreground">{row.label}</span>
                      </span>
                      <span className="flex-1 self-end mb-[3px] border-b border-dotted border-muted-foreground/30" />
                      <span className="text-sm font-bold font-lora tabular-nums shrink-0">{row.value}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            {/* Card 2 · Performance — vacío por ahora */}
            <Card className="overflow-hidden h-full">
              <div className="h-1.5 w-full" style={{ background: '#A347D1' }} />
              <CardContent className="pt-4 pb-5">
                <h3 className="font-sugar text-2xl text-foreground mb-3 text-center">Performance</h3>
                <ul className="space-y-2.5">
                  <li className="flex items-baseline gap-2">
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: '#A347D1' }} />
                      <span className="text-sm text-foreground">Tiempo total de ejecución</span>
                    </span>
                    <span className="flex-1 self-end mb-[3px] border-b border-dotted border-muted-foreground/30" />
                    <span className="text-sm font-bold font-lora tabular-nums shrink-0">{formatExecTotal(metrics.totalExecutionMs)}</span>
                  </li>
                  <li className="flex items-baseline gap-2">
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: '#6366f1' }} />
                      <span className="text-sm text-foreground">Promedio por documento</span>
                    </span>
                    <span className="flex-1 self-end mb-[3px] border-b border-dotted border-muted-foreground/30" />
                    <span className="text-sm font-bold font-lora tabular-nums shrink-0">{formatAvgPerDoc(metrics.totalExecutionMs, metrics.totalDocuments)}</span>
                  </li>
                  <li className="flex items-baseline gap-2">
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: '#22C365' }} />
                      <span className="text-sm text-foreground">Efectividad de extracción</span>
                    </span>
                    <span className="flex-1 self-end mb-[3px] border-b border-dotted border-muted-foreground/30" />
                    <span className="text-sm font-bold font-lora tabular-nums shrink-0">{formatEffectiveness(metrics.avgConfidence)}</span>
                  </li>
                  <li className="flex items-baseline gap-2">
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: '#94a3b8' }} />
                      <span className="text-sm text-foreground">Efectividad del sistema</span>
                    </span>
                    <span className="flex-1 self-end mb-[3px] border-b border-dotted border-muted-foreground/30" />
                    <span className="text-sm font-bold font-lora tabular-nums shrink-0">{formatEffectiveness(systemAvgConfidence)}</span>
                  </li>
                </ul>
              </CardContent>
            </Card>

            {/* Card 3 · Costo por documento — desglose de precios (RPC get_price_breakdown) */}
            <Card className="overflow-hidden h-full">
              <div className="h-1.5 w-full" style={{ background: '#FED210' }} />
              <CardContent className="pt-4 pb-5">
                <h3 className="font-sugar text-2xl text-foreground mb-3 text-center">Costo por documento</h3>
                {priceBreakdown ? (
                  <ul className="space-y-2.5">
                    <li className="flex items-baseline gap-2">
                      <span className="text-sm text-foreground shrink-0">Precio base</span>
                      <span className="flex-1 self-end mb-[3px] border-b border-dotted border-muted-foreground/30" />
                      <span className="text-sm font-bold font-lora tabular-nums shrink-0">${priceBreakdown.base_price.toFixed(2)}</span>
                    </li>
                    {priceBreakdown.features.map((f) => (
                      <li key={f.key} className="flex items-baseline gap-2">
                        <span className="text-sm text-foreground shrink-0">{f.label}</span>
                        <span className="flex-1 self-end mb-[3px] border-b border-dotted border-muted-foreground/30" />
                        <span className="text-sm font-bold font-lora tabular-nums shrink-0">${f.cost.toFixed(2)}</span>
                      </li>
                    ))}
                    {priceBreakdown.polling && (
                      <li className="flex items-baseline gap-2">
                        <span className="text-sm text-foreground shrink-0">Escucha {priceBreakdown.polling.label}</span>
                        <span className="flex-1 self-end mb-[3px] border-b border-dotted border-muted-foreground/30" />
                        <span className="text-sm font-bold font-lora tabular-nums shrink-0">${priceBreakdown.polling.cost.toFixed(2)}</span>
                      </li>
                    )}
                    <li className="flex items-baseline gap-2 border-t border-border pt-2 mt-1">
                      <span className="text-sm font-medium text-foreground shrink-0">Total por documento</span>
                      <span className="flex-1 self-end mb-[3px] border-b border-dotted border-muted-foreground/30" />
                      <span className="text-sm font-bold font-lora tabular-nums shrink-0">${priceBreakdown.total_per_doc.toFixed(2)}</span>
                    </li>
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground/50">Cargando…</p>
                )}
                {integrations.filter((i) => i.is_active).map((i) => (
                  <div key={i.id} className="flex items-center justify-between gap-2 mt-3 px-2.5 py-2 rounded-lg bg-muted/50">
                    <span className="text-xs text-muted-foreground">Integración · {INTEGRATION_LABELS[i.integration_type] ?? i.integration_type}</span>
                    <Switch checked={i.is_active} onChange={() => handleToggleIntegration(i)} disabled={togglingIntg === i.id} />
                  </div>
                ))}
              </CardContent>
            </Card>
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
              <>
              <Card>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Fecha proceso</TableHead>
                      <TableHead>Cliente</TableHead>
                      <TableHead>Origen</TableHead>
                      <TableHead>Período</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead>Tiempo</TableHead>
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
                          <div className="flex items-center gap-1.5">
                            <JobStatusBadge
                              status={job.status}
                              total_documents={job.total_documents}
                              processed_documents={job.processed_documents}
                              failed_documents={job.failed_documents}
                              has_warnings={job.has_warnings}
                            />
                            {job.has_duplicate && (
                              <span
                                title="Este proceso contiene al menos un documento duplicado (no se generó su CSV de salida)"
                                className="inline-flex cursor-default"
                              >
                                <AlertTriangle className="h-4 w-4 text-orange-500" aria-label="Contiene un documento duplicado" />
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm tabular-nums text-muted-foreground">
                          {formatDuration(job.created_at, job.finished_at)}
                        </TableCell>
                        <TableCell className="text-sm tabular-nums">
                          {formatDocuments(job)}{correctedBadge(job)}
                        </TableCell>
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
              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-3">
                  <span className="text-sm text-muted-foreground">
                    Página {page} de {totalPages} · {totalJobs} procesos
                  </span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                      Anterior
                    </Button>
                    <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                      Siguiente
                    </Button>
                  </div>
                </div>
              )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
