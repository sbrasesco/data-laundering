import { useState, useEffect, useCallback } from 'react';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { supabase } from '../lib/supabase';

// ─── Descripciones de features para tooltips ──────────────────────────────────
const FEATURE_DESCRIPTIONS: Record<string, string> = {
  integration_drive:
    'Escribe y actualiza el archivo procesado directamente en tu Google Drive. El servicio base solo descarga el archivo; esta feature lo sube y lo mantiene en la nube automáticamente.',
  integration_drive_multiclient:
    'Organiza los archivos en subcarpetas separadas por cliente dentro de tu Drive. En lugar de una carpeta raíz única, cada cliente tiene su propia carpeta con sus documentos.',
  integration_firebase:
    'Deposita el archivo procesado en tu Firebase Storage. Ideal para apps o sistemas que ya consumen datos desde Firebase.',
  integration_ftp:
    'Transfiere el archivo procesado a un servidor FTP remoto configurado por el cliente.',
  integration_sftp:
    'Igual que FTP pero con transferencia cifrada (SSH). Para clientes que requieren mayor seguridad en la transferencia.',
  human_review:
    'Los documentos con baja confianza de clasificación quedan en espera antes de procesarse. Un operador los revisa y aprueba manualmente, garantizando mayor exactitud.',
  master_file:
    'En lugar de un archivo por lote, mantiene un único Excel acumulativo que se va completando con cada proceso. Todo el historial en un solo archivo siempre actualizado.',
  xlsx_output:
    'Genera el resultado en formato Excel (.xlsx) y lo mantiene actualizado en Drive. La descarga básica (CSV o Excel puntual) es parte del servicio base; este adicional escribe y actualiza el archivo en la nube.',
  polling_interval_1min:
    'Determina cada cuánto el sistema escanea carpetas en busca de nuevos archivos. El intervalo mínimo (1 min) implica mayor carga continua en el sistema. A mayor frecuencia de escucha, mayor costo por el uso de infraestructura.',
};

// ─── Types ────────────────────────────────────────────────────────────────────
interface JobSummary    { status: string; error_type: string | null; count: number; }
interface RecentError   { id: string; organization_name: string | null; error_type: string | null; error_message: string | null; created_at: string; }
interface TenantBalance { org_id: string; name: string; balance: number; is_active: boolean; extract_attachments: boolean; }
interface DocsStats     { total_processed: number; processed_24h: number; }
interface AdminUser     { user_id: string; email: string; org_id: string | null; org_name: string | null; is_superadmin: boolean; created_at: string; }
interface StuckJob      { job_id: string; org_name: string | null; created_at: string; minutes_stuck: number; }
interface WorkerHealth  { status: 'ok' | 'error' | 'timeout' | 'checking'; worker_version?: string; google_oauth?: boolean; latency_ms?: number; }
interface WorkerMetrics { timestamp: string; worker_version: string; queue_depth: { waiting: number; active: number; delayed: number }; totals: { completed: number; failed: number }; latency_ms: { p50: number | null; p95: number | null; avg: number | null; sample_size: number }; error_rate_pct: number; }
interface TenantJob     { id: string; status: string; error_type: string | null; created_at: string; finished_at: string | null; total_documents: number | null; processed_documents: number | null; failed_documents: number | null; input_source: string | null; }
interface PricingPlan     { name: string; display_name: string; price_per_doc: number; balance_usd: number; docs_included: number; }
interface PricingFeature  { feature_key: string; label: string; cost_usd: number; }
interface PollingTierAdmin{ interval_minutes: number; label: string; cost_per_doc: number; active: boolean; sort_order: number; }
interface DocTypeAdmin    { code: string; label: string; sort_order: number; active: boolean; }

type ModalKey = 'jobs' | 'docs' | 'errors' | 'tenants' | 'users' | 'worker' | 'stuck' | 'activity' | 'prices' | 'queue' | 'prompt' | 'doctypes' | null;

// ─── FeatureRow ───────────────────────────────────────────────────────────────
function FeatureRow({ feat, editPrices, setEditPrices, savingPrice, onSave, indent, border }: {
  feat: PricingFeature;
  editPrices: Record<string, string>;
  setEditPrices: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  savingPrice: string | null;
  onSave: (featureKey: string) => void;
  indent?: boolean;
  border?: boolean;
}) {
  const key = `feat_${feat.feature_key}`;
  const editVal = editPrices[key];
  const isDirty = editVal !== undefined;
  const desc = FEATURE_DESCRIPTIONS[feat.feature_key];

  return (
    <div className={`flex items-center gap-3 px-3 py-2.5 ${indent ? 'pl-7 bg-muted/10' : ''} ${border ? 'border-b' : ''}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium">{feat.label}</p>
          {desc && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" className="text-muted-foreground/40 hover:text-muted-foreground transition-colors flex-shrink-0">
                    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <circle cx="12" cy="12" r="10"/>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 16v-4M12 8h.01"/>
                    </svg>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-64 text-xs leading-relaxed">
                  {desc}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        <p className="text-xs text-muted-foreground font-mono">{feat.feature_key}</p>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">+$</span>
        <input
          type="number" step="0.01" min="0"
          value={editVal ?? Number(feat.cost_usd).toFixed(4)}
          onChange={e => setEditPrices(prev => ({ ...prev, [key]: e.target.value }))}
          className="w-24 h-7 rounded-md border border-input bg-background px-2 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button size="sm" className="h-7 px-2.5 text-xs" disabled={!isDirty || savingPrice === key} onClick={() => onSave(feat.feature_key)}>
          {savingPrice === key ? '...' : 'Guardar'}
        </Button>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatDate(iso: string) {
  return new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function ErrorTypeBadge({ type }: { type: string | null }) {
  if (type === 'credits')    return <Badge variant="warning">créditos</Badge>;
  if (type === 'processing') return <Badge variant="destructive">sistema</Badge>;
  return <Badge variant="secondary">—</Badge>;
}

// ─── Square monitor card ──────────────────────────────────────────────────────
function MonitorCard({
  title, accent, metric, sub, icon, onClick,
}: {
  title: string; accent: string; metric: number | string; sub: string;
  icon: React.ReactNode; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex flex-col items-center justify-center rounded-xl border bg-card text-center transition-all hover:shadow-md hover:-translate-y-0.5 active:translate-y-0 overflow-hidden"
      style={{ aspectRatio: '1 / 1' }}
    >
      <div className="absolute top-0 left-0 right-0 h-1" style={{ background: accent }} />
      <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3 text-white" style={{ background: accent }}>
        {icon}
      </div>
      <div className="text-3xl font-bold tracking-tight font-lora">{metric}</div>
      <div className="text-xs font-semibold uppercase tracking-wide mt-1 text-muted-foreground">{title}</div>
      <div className="text-xs text-muted-foreground/70 mt-0.5">{sub}</div>
      <div className="absolute bottom-2 right-3 text-[10px] text-muted-foreground/40 group-hover:text-muted-foreground/70 transition-colors">Ver →</div>
    </button>
  );
}

// ─── SVG icons ────────────────────────────────────────────────────────────────
const IconJobs    = () => <svg width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>;
const IconQueue   = () => <svg width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="3.5" rx="1" strokeLinecap="round"/><rect x="3" y="10" width="13" height="3.5" rx="1" strokeLinecap="round"/><rect x="3" y="16" width="8" height="3.5" rx="1" strokeLinecap="round"/></svg>;
const IconDocs    = () => <svg width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>;
const IconErrors  = () => <svg width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>;
const IconTenants = () => <svg width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>;
const IconUsers   = () => <svg width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>;
const IconWorker  = () => <svg width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path strokeLinecap="round" strokeLinejoin="round" d="M8 21h8M12 17v4"/><circle cx="12" cy="10" r="2" fill="currentColor" stroke="none"/></svg>;
const IconStuck   = () => <svg width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline strokeLinecap="round" strokeLinejoin="round" points="12 6 12 12 16 14"/></svg>;
const IconPrices  = () => <svg width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z"/></svg>;

// ─── Page ─────────────────────────────────────────────────────────────────────
export function MonitoringPage() {
  const [jobSummary,     setJobSummary]     = useState<JobSummary[]>([]);
  const [recentErrors,   setRecentErrors]   = useState<RecentError[]>([]);
  const [tenantBalances, setTenantBalances] = useState<TenantBalance[]>([]);
  const [docsStats,      setDocsStats]      = useState<DocsStats>({ total_processed: 0, processed_24h: 0 });
  const [adminUsers,     setAdminUsers]     = useState<AdminUser[]>([]);
  const [usersError,     setUsersError]     = useState<string | null>(null);
  const [stuckJobs,      setStuckJobs]      = useState<StuckJob[]>([]);
  const [workerHealth,   setWorkerHealth]   = useState<WorkerHealth>({ status: 'checking' });
  const [workerMetrics,  setWorkerMetrics]  = useState<WorkerMetrics | null>(null);
  const [metricsError,   setMetricsError]   = useState<string | null>(null);
  const [failingJob,     setFailingJob]     = useState<string | null>(null);
  const [rechargeTarget, setRechargeTarget] = useState<TenantBalance | null>(null);
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [recharging,     setRecharging]     = useState(false);
  const [togglingTenant,  setTogglingTenant]  = useState<string | null>(null);
  const [togglingAttach,  setTogglingAttach]  = useState<string | null>(null);
  const [activityTarget,  setActivityTarget]  = useState<TenantBalance | null>(null);
  const [tenantJobs,      setTenantJobs]      = useState<TenantJob[]>([]);
  const [loadingActivity, setLoadingActivity] = useState(false);
  const [activityError,   setActivityError]   = useState<string | null>(null);
  const [loading,        setLoading]        = useState(true);
  const [lastUpdated,    setLastUpdated]    = useState<Date | null>(null);
  const [modal,          setModal]          = useState<ModalKey>(null);
  const [promptText,     setPromptText]     = useState<string>('');
  const [promptInfo,     setPromptInfo]     = useState<{ extraction_model?: string; ocr_model?: string }>({});
  const [promptLoading,  setPromptLoading]  = useState(false);
  const [promptError,    setPromptError]    = useState<string | null>(null);
  const [togglingUser,   setTogglingUser]   = useState<string | null>(null);
  const [pricingPlans,        setPricingPlans]        = useState<PricingPlan[]>([]);
  const [pricingFeatures,     setPricingFeatures]     = useState<PricingFeature[]>([]);
  const [editPrices,          setEditPrices]          = useState<Record<string, string>>({});
  const [savingPrice,         setSavingPrice]         = useState<string | null>(null);
  const [pollingTiers,        setPollingTiers]        = useState<PollingTierAdmin[]>([]);
  const [editPollingTiers,    setEditPollingTiers]    = useState<Record<string, string>>({});
  const [savingPollingTier,   setSavingPollingTier]   = useState<number | null>(null);
  const [togglingPollingTier, setTogglingPollingTier] = useState<number | null>(null);
  const [docTypes,            setDocTypes]            = useState<DocTypeAdmin[]>([]);
  const [editDocLabels,       setEditDocLabels]       = useState<Record<string, string>>({});
  const [savingDocType,       setSavingDocType]       = useState<string | null>(null);
  const [togglingDocType,     setTogglingDocType]     = useState<string | null>(null);
  const [newDocCode,          setNewDocCode]          = useState('');
  const [newDocLabel,         setNewDocLabel]         = useState('');
  const [addingDocType,       setAddingDocType]       = useState(false);

  const GATEWAY_BASE = (import.meta.env.VITE_WORKER_GATEWAY_URL as string ?? '');

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // Jobs
      const { data: rawJobs } = await supabase.from('pdf_jobs').select('status, error_type');
      const counts: Record<string, number> = {};
      for (const row of rawJobs ?? []) {
        const key = `${row.status}__${row.error_type ?? 'null'}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      setJobSummary(Object.entries(counts).map(([key, count]) => {
        const [status, et] = key.split('__');
        return { status, error_type: et === 'null' ? null : et, count };
      }));

      // Errores recientes
      const { data: errorsData } = await supabase.from('pdf_jobs').select('id, organization_id, error_type, error_message, created_at').eq('status', 'error').order('created_at', { ascending: false }).limit(10);
      const orgIds = [...new Set((errorsData ?? []).map((e) => e.organization_id))];
      const orgNames: Record<string, string> = {};
      if (orgIds.length > 0) {
        const { data: orgsData } = await supabase.from('organizations').select('id, name').in('id', orgIds);
        for (const o of orgsData ?? []) orgNames[o.id] = o.name;
      }
      setRecentErrors((errorsData ?? []).map((e) => ({
        id: e.id,
        organization_name: orgNames[e.organization_id] ?? e.organization_id?.slice(0, 8) + '…',
        error_type: e.error_type,
        error_message: e.error_message,
        created_at: e.created_at,
      })));

      // Balance por tenant (RPC bypass RLS para superadmin)
      const { data: tenantsData } = await supabase.rpc('get_all_tenants_admin');
      // Flag de extracción de adjuntos por org (TASK-108)
      const { data: attachFlags } = await supabase.rpc('get_tenant_attachment_flags');
      const attachOn = new Set<string>((attachFlags ?? [])
        .filter((f: { org_id: string; extract_embedded_attachments: boolean }) => f.extract_embedded_attachments)
        .map((f: { org_id: string }) => f.org_id));
      setTenantBalances(
        (tenantsData ?? []).map((t: { org_id: string; name: string; is_active: boolean; balance: number }) => ({
          org_id: t.org_id,
          name: t.name ?? t.org_id?.slice(0, 8) + '…',
          balance: t.balance ?? 0,
          is_active: t.is_active ?? true,
          extract_attachments: attachOn.has(t.org_id),
        }))
      );

      // Docs stats
      const { data: allJobs } = await supabase.from('pdf_jobs').select('processed_documents, created_at').in('status', ['done', 'done_with_warnings']);
      const now = Date.now(); const h24 = 86400000; let total = 0; let last24 = 0;
      for (const j of allJobs ?? []) {
        const docs = j.processed_documents ?? 0;
        total += docs;
        if (now - new Date(j.created_at).getTime() < h24) last24 += docs;
      }
      setDocsStats({ total_processed: total, processed_24h: last24 });

      // Usuarios (RPC superadmin)
      setUsersError(null);
      const { data: usersData, error: usersErr } = await supabase.rpc('get_all_users_admin');
      if (usersErr) {
        setUsersError(usersErr.message);
        setAdminUsers([]);
      } else {
        setAdminUsers((usersData ?? []) as AdminUser[]);
      }

      // Jobs trabados (>20 min en processing)
      const { data: stuckData } = await supabase.rpc('get_stuck_jobs', { p_minutes_threshold: 20 });
      setStuckJobs((stuckData ?? []) as StuckJob[]);

      // Precios
      const { data: plansData } = await supabase
        .from('billing_plans')
        .select('name, display_name, price_per_doc, balance_usd, docs_included')
        .in('name', ['basico', 'profesional', 'business'])
        .eq('active', true)
        .order('balance_usd', { ascending: true });
      setPricingPlans((plansData ?? []) as PricingPlan[]);

      const { data: featuresData } = await supabase
        .from('feature_pricing_multipliers')
        .select('feature_key, label, cost_usd')
        .eq('active', true)
        .order('feature_key');
      setPricingFeatures((featuresData ?? []) as PricingFeature[]);

      const { data: pollingTiersData } = await supabase
        .from('polling_interval_tiers')
        .select('interval_minutes, label, cost_per_doc, active, sort_order')
        .order('sort_order', { ascending: true });
      setPollingTiers((pollingTiersData ?? []) as PollingTierAdmin[]);

      // Tipos de documento (activos + inactivos - TASK-111)
      const { data: docTypesData } = await supabase
        .from('document_types')
        .select('code, label, sort_order, active')
        .order('sort_order', { ascending: true });
      setDocTypes((docTypesData ?? []) as DocTypeAdmin[]);

      setLastUpdated(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  const GATEWAY_API_KEY = (import.meta.env.VITE_WORKER_API_KEY as string) ?? '';

  const checkWorkerHealth = useCallback(async () => {
    setWorkerHealth({ status: 'checking' });
    const t0 = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${GATEWAY_BASE}/health`, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${GATEWAY_API_KEY}` },
      });
      clearTimeout(timeout);
      const latency_ms = Date.now() - t0;
      if (res.ok) {
        const body = await res.json();
        setWorkerHealth({ status: 'ok', worker_version: body.worker_version, google_oauth: body.google_oauth, latency_ms });
      } else {
        setWorkerHealth({ status: 'error', latency_ms });
      }
    } catch {
      setWorkerHealth({ status: Date.now() - t0 >= 4900 ? 'timeout' : 'error' });
    }
  }, [GATEWAY_BASE]);

  const fetchWorkerMetrics = useCallback(async () => {
    try {
      const controller = new AbortController();
      const timeout    = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${GATEWAY_BASE}/api/metrics`, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${GATEWAY_API_KEY}` },
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        setWorkerMetrics(data as WorkerMetrics);
        setMetricsError(null);
      } else {
        setMetricsError(`HTTP ${res.status}`);
      }
    } catch (err) {
      setMetricsError(err instanceof Error ? err.message : 'Error');
    }
  }, [GATEWAY_BASE]);

  useEffect(() => { fetchData(); checkWorkerHealth(); fetchWorkerMetrics(); }, [fetchData, checkWorkerHealth, fetchWorkerMetrics]);

  useEffect(() => {
    const interval = setInterval(fetchWorkerMetrics, 30_000);
    return () => clearInterval(interval);
  }, [fetchWorkerMetrics]);

  const handleViewPrompt = async () => {
    setModal('prompt');
    setPromptLoading(true);
    setPromptError(null);
    try {
      const res = await fetch(`${GATEWAY_BASE}/api/prompt`, { headers: { Authorization: `Bearer ${GATEWAY_API_KEY}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPromptText(data.prompt ?? '');
      setPromptInfo({ extraction_model: data.extraction_model, ocr_model: data.ocr_model });
    } catch (err) {
      setPromptError(err instanceof Error ? err.message : 'Error');
    } finally {
      setPromptLoading(false);
    }
  };

  const handleViewActivity = async (t: TenantBalance) => {
    setActivityTarget(t);
    setTenantJobs([]);
    setActivityError(null);
    setModal('activity');
    setLoadingActivity(true);
    try {
      const { data, error } = await supabase.rpc('get_tenant_jobs_admin', { p_org_id: t.org_id });
      if (error) throw error;
      setTenantJobs((data ?? []) as TenantJob[]);
    } catch (err) {
      console.error('Error cargando actividad del tenant:', err);
      setActivityError('No se pudo cargar la actividad. Reintentá.');
    } finally {
      setLoadingActivity(false);
    }
  };

  const handleToggleTenant = async (t: TenantBalance) => {
    setTogglingTenant(t.org_id);
    try {
      const { error } = await supabase.rpc('set_tenant_active', { p_org_id: t.org_id, p_value: !t.is_active });
      if (error) throw error;
      setTenantBalances(prev => prev.map(x => x.org_id === t.org_id ? { ...x, is_active: !t.is_active } : x));
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Error');
    } finally {
      setTogglingTenant(null);
    }
  };

  const handleToggleAttachExtraction = async (t: TenantBalance) => {
    setTogglingAttach(t.org_id);
    try {
      const { error } = await supabase.rpc('set_tenant_attachment_extraction', { p_org_id: t.org_id, p_value: !t.extract_attachments });
      if (error) throw error;
      setTenantBalances(prev => prev.map(x => x.org_id === t.org_id ? { ...x, extract_attachments: !t.extract_attachments } : x));
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Error');
    } finally {
      setTogglingAttach(null);
    }
  };

  const handleRecharge = async () => {
    if (!rechargeTarget) return;
    const amount = parseFloat(rechargeAmount);
    if (!amount || isNaN(amount) || amount <= 0) return;
    setRecharging(true);
    try {
      const { data: newBalance, error } = await supabase.rpc('add_credits_admin', { p_org_id: rechargeTarget.org_id, p_amount_usd: amount });
      if (error) throw error;
      setTenantBalances(prev => prev.map(t => t.org_id === rechargeTarget.org_id ? { ...t, balance: newBalance as number } : t).sort((a, b) => a.balance - b.balance));
      setRechargeTarget(null);
      setRechargeAmount('');
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Error al recargar');
    } finally {
      setRecharging(false);
    }
  };

  const handleFailStuckJob = async (jobId: string) => {
    setFailingJob(jobId);
    try {
      const { error } = await supabase.rpc('fail_stuck_job', { p_job_id: jobId });
      if (error) throw error;
      setStuckJobs(prev => prev.filter(j => j.job_id !== jobId));
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Error');
    } finally {
      setFailingJob(null);
    }
  };

  const handleToggleSuperadmin = async (userId: string, currentValue: boolean) => {
    setTogglingUser(userId);
    try {
      const { error } = await supabase.rpc('set_user_superadmin', { p_user_id: userId, p_value: !currentValue });
      if (error) throw error;
      setAdminUsers(prev => prev.map(u => u.user_id === userId ? { ...u, is_superadmin: !currentValue } : u));
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Error al cambiar el rol');
    } finally {
      setTogglingUser(null);
    }
  };

  const handleSavePlanPrice = async (planName: string) => {
    const key = `plan_${planName}`;
    const val = parseFloat(editPrices[key] ?? '');
    if (isNaN(val) || val < 0) return;
    setSavingPrice(key);
    try {
      const { error } = await supabase.rpc('update_plan_price', { p_plan_name: planName, p_price_per_doc: val });
      if (error) throw error;
      setPricingPlans(prev => prev.map(p => p.name === planName ? { ...p, price_per_doc: val } : p));
      setEditPrices(prev => { const n = { ...prev }; delete n[key]; return n; });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setSavingPrice(null);
    }
  };

  const handleSaveFeatureCost = async (featureKey: string) => {
    const key = `feat_${featureKey}`;
    const val = parseFloat(editPrices[key] ?? '');
    if (isNaN(val) || val < 0) return;
    setSavingPrice(key);
    try {
      const { error } = await supabase.rpc('update_feature_cost', { p_feature_key: featureKey, p_cost_usd: val });
      if (error) throw error;
      setPricingFeatures(prev => prev.map(f => f.feature_key === featureKey ? { ...f, cost_usd: val } : f));
      setEditPrices(prev => { const n = { ...prev }; delete n[key]; return n; });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setSavingPrice(null);
    }
  };

  const handleSavePollingTierCost = async (intervalMinutes: number) => {
    const key = `poll_${intervalMinutes}`;
    const val = parseFloat(editPollingTiers[key] ?? '');
    if (isNaN(val) || val < 0) return;
    setSavingPollingTier(intervalMinutes);
    try {
      const { error } = await supabase.rpc('update_polling_tier', {
        p_interval_minutes: intervalMinutes,
        p_cost_per_doc: val,
      });
      if (error) throw error;
      setPollingTiers(prev => prev.map(t => t.interval_minutes === intervalMinutes ? { ...t, cost_per_doc: val } : t));
      setEditPollingTiers(prev => { const n = { ...prev }; delete n[key]; return n; });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setSavingPollingTier(null);
    }
  };

  const handleTogglePollingTier = async (intervalMinutes: number, currentActive: boolean) => {
    setTogglingPollingTier(intervalMinutes);
    try {
      const { error } = await supabase.rpc('update_polling_tier', {
        p_interval_minutes: intervalMinutes,
        p_active: !currentActive,
      });
      if (error) throw error;
      setPollingTiers(prev => prev.map(t => t.interval_minutes === intervalMinutes ? { ...t, active: !currentActive } : t));
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Error al cambiar estado');
    } finally {
      setTogglingPollingTier(null);
    }
  };

  // Tipos de documento (TASK-111)
  const handleSaveDocTypeLabel = async (code: string) => {
    const val = (editDocLabels[code] ?? '').trim();
    if (!val) return;
    setSavingDocType(code);
    try {
      const { error } = await supabase.rpc('upsert_document_type', { p_code: code, p_label: val });
      if (error) throw error;
      setDocTypes(prev => prev.map(d => d.code === code ? { ...d, label: val } : d));
      setEditDocLabels(prev => { const n = { ...prev }; delete n[code]; return n; });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setSavingDocType(null);
    }
  };

  const handleToggleDocType = async (code: string, currentActive: boolean) => {
    setTogglingDocType(code);
    try {
      const { error } = await supabase.rpc('toggle_document_type', { p_code: code, p_active: !currentActive });
      if (error) throw error;
      setDocTypes(prev => prev.map(d => d.code === code ? { ...d, active: !currentActive } : d));
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Error al cambiar estado');
    } finally {
      setTogglingDocType(null);
    }
  };

  const handleAddDocType = async () => {
    const code = newDocCode.trim().toUpperCase().replace(/\s+/g, '_');
    const label = newDocLabel.trim();
    if (!code || !label) return;
    if (docTypes.some(d => d.code === code)) { alert('Ya existe un tipo con ese codigo'); return; }
    setAddingDocType(true);
    try {
      const { error } = await supabase.rpc('upsert_document_type', { p_code: code, p_label: label });
      if (error) throw error;
      const nextOrder = docTypes.reduce((m, d) => Math.max(m, d.sort_order), 0) + 10;
      setDocTypes(prev => [...prev, { code, label, sort_order: nextOrder, active: true }]);
      setNewDocCode(''); setNewDocLabel('');
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Error al agregar');
    } finally {
      setAddingDocType(false);
    }
  };

  // Métricas derivadas
  const totalJobs     = jobSummary.reduce((s, r) => s + r.count, 0);
  const completedJobs = jobSummary.filter(r => r.status === 'done' || r.status === 'done_with_warnings').reduce((s, r) => s + r.count, 0);
  const errorSystem   = jobSummary.filter(r => r.status === 'error' && r.error_type !== 'credits').reduce((s, r) => s + r.count, 0);
  const errorCredits  = jobSummary.filter(r => r.status === 'error' && r.error_type === 'credits').reduce((s, r) => s + r.count, 0);
  const processing    = jobSummary.filter(r => r.status === 'processing').reduce((s, r) => s + r.count, 0);
  const errorRate     = totalJobs > 0 ? Math.round((errorSystem / totalJobs) * 100) : 0;
  const isCritical    = errorRate > 3;
  const isWarning     = errorRate >= 1 && errorRate <= 3;

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            <span className="inline-block px-2 py-0.5 rounded-lg" style={{ background: '#FED210', color: '#000000' }}>Monitoreo</span>
          </h1>
          <p className="text-sm text-muted-foreground">Estado general del sistema.</p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && <span className="text-xs text-muted-foreground">{lastUpdated.toLocaleTimeString('es-AR')}</span>}
          <Button variant="outline" size="sm" onClick={() => { fetchData(); checkWorkerHealth(); }} disabled={loading}>{loading ? 'Actualizando…' : '↻ Actualizar'}</Button>
        </div>
      </div>

      {loading && !lastUpdated ? <LoadingSpinner /> : (
        <>
          {/* Barra de salud */}
          {totalJobs > 0 && (
            <div className={`rounded-lg border px-4 py-3 text-sm font-medium flex items-center gap-2 ${isCritical ? 'border-red-200 bg-red-50 text-red-800' : isWarning ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-green-200 bg-green-50 text-green-800'}`}>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isCritical ? 'bg-red-500' : isWarning ? 'bg-amber-400' : 'bg-green-500'}`} />
              {isCritical
                ? `Sistema crítico — error rate: ${errorRate}% (umbral > 3%)`
                : isWarning
                ? `Atención — error rate: ${errorRate}%`
                : `Sistema saludable — error rate: ${errorRate}%`
              }
            </div>
          )}

          {/* Grid de tarjetas cuadradas */}
          <div className="grid grid-cols-3 lg:grid-cols-5 gap-4 auto-rows-fr">
            <MonitorCard
              title="Jobs" accent="#22C365" icon={<IconJobs />}
              metric={totalJobs} sub={`${completedJobs} completados`}
              onClick={() => setModal('jobs')}
            />
            <MonitorCard
              title="Documentos" accent="#000000" icon={<IconDocs />}
              metric={docsStats.total_processed} sub={`${docsStats.processed_24h} hoy`}
              onClick={() => setModal('docs')}
            />
            <MonitorCard
              title="Errores" accent="#e11d48" icon={<IconErrors />}
              metric={recentErrors.length} sub="últimos 10"
              onClick={() => setModal('errors')}
            />
            <MonitorCard
              title="Tenants" accent="#A347D1" icon={<IconTenants />}
              metric={tenantBalances.length} sub="organizaciones"
              onClick={() => setModal('tenants')}
            />
            <MonitorCard
              title="Usuarios" accent="#FED210" icon={<IconUsers />}
              metric={adminUsers.length} sub={usersError ? 'error al cargar' : 'registrados'}
              onClick={() => setModal('users')}
            />
            <MonitorCard
              title="Worker" accent={workerHealth.status === 'ok' ? '#22C365' : workerHealth.status === 'checking' ? '#94a3b8' : '#e11d48'}
              icon={<IconWorker />}
              metric={workerHealth.status === 'ok' ? 'Online' : workerHealth.status === 'checking' ? '...' : workerHealth.status === 'timeout' ? 'Timeout' : 'Offline'}
              sub={workerHealth.status === 'ok' ? `${workerHealth.latency_ms}ms · v${workerHealth.worker_version ?? '?'}` : 'gateway health'}
              onClick={() => setModal('worker')}
            />
            <MonitorCard
              title="Trabados" accent={stuckJobs.length > 0 ? '#e11d48' : '#22C365'}
              icon={<IconStuck />}
              metric={stuckJobs.length}
              sub=">20 min en processing"
              onClick={() => setModal('stuck')}
            />
            <MonitorCard
              title="Cola"
              accent={
                metricsError ? '#94a3b8'
                : workerMetrics && workerMetrics.error_rate_pct > 5 ? '#e11d48'
                : workerMetrics && workerMetrics.queue_depth.waiting > 10 ? '#f59e0b'
                : workerMetrics ? '#22C365'
                : '#94a3b8'
              }
              icon={<IconQueue />}
              metric={workerMetrics ? workerMetrics.queue_depth.waiting : '—'}
              sub={workerMetrics ? `${workerMetrics.queue_depth.active} activos · ${workerMetrics.error_rate_pct}% err` : metricsError ? 'sin datos' : 'cargando…'}
              onClick={() => setModal('queue')}
            />
            <MonitorCard
              title="Precios" accent="#f97316"
              icon={<IconPrices />}
              metric={pricingPlans.length > 0 ? `$${Number(pricingPlans[0]?.price_per_doc ?? 0).toFixed(2)}` : '—'}
              sub="base doc · click para editar"
              onClick={() => { setEditPrices({}); setModal('prices'); }}
            />
            <MonitorCard
              title="Tipos de doc" accent="#0ea5e9"
              icon={<svg width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 4H7a2 2 0 01-2-2V6a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z"/></svg>}
              metric={`${docTypes.filter(d => d.active).length}`}
              sub="activos · click para administrar"
              onClick={() => { setEditDocLabels({}); setNewDocCode(''); setNewDocLabel(''); setModal('doctypes'); }}
            />
            <MonitorCard
              title="Prompt" accent="#6366f1"
              icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>}
              metric="IA"
              sub="ver prompt de extracción"
              onClick={handleViewPrompt}
            />
          </div>
        </>
      )}

      {/* ── Modales ──────────────────────────────────────────────────────────── */}

      {/* Prompt del worker (TASK-114) — solo lectura */}
      <Dialog open={modal === 'prompt'} onOpenChange={() => setModal(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Prompt de extracción (worker)</DialogTitle></DialogHeader>
          {promptLoading ? (
            <div className="py-8 flex justify-center"><LoadingSpinner /></div>
          ) : promptError ? (
            <p className="text-sm text-destructive py-6 text-center">No se pudo cargar el prompt: {promptError}</p>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Solo lectura. Extracción: <span className="font-medium">{promptInfo.extraction_model ?? '—'}</span> · OCR: <span className="font-medium">{promptInfo.ocr_model ?? '—'}</span>. Para editarlo hay que cambiarlo en el worker y redesplegar.
              </p>
              <pre className="text-xs whitespace-pre-wrap break-all rounded-md border bg-muted/40 p-3 font-mono max-h-[60vh] overflow-y-auto">{promptText}</pre>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Jobs */}
      <Dialog open={modal === 'jobs'} onOpenChange={() => setModal(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Jobs — detalle</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3 mt-2">
            {[
              { label: 'Total', value: totalJobs, color: '#000000' },
              { label: 'Exitosos', value: completedJobs, color: '#22C365' },
              { label: 'En proceso', value: processing, color: '#FED210' },
              { label: 'Error sistema', value: errorSystem, color: '#e11d48' },
              { label: 'Error créditos', value: errorCredits, color: '#A347D1' },
            ].map(({ label, value, color }) => (
              <div key={label} className="rounded-lg border p-4 flex flex-col items-center text-center overflow-hidden relative">
                <div className="absolute top-0 left-0 right-0 h-1" style={{ background: color }} />
                <div className="text-2xl font-black mt-1">{value}</div>
                <div className="text-xs text-muted-foreground mt-1">{label}</div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Documentos */}
      <Dialog open={modal === 'docs'} onOpenChange={() => setModal(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Documentos procesados</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3 mt-2">
            <div className="rounded-lg border p-5 flex flex-col items-center text-center">
              <div className="text-3xl font-black">{docsStats.total_processed.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground mt-1">Total histórico</div>
            </div>
            <div className="rounded-lg border p-5 flex flex-col items-center text-center">
              <div className="text-3xl font-black">{docsStats.processed_24h.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground mt-1">Últimas 24h</div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Errores recientes */}
      <Dialog open={modal === 'errors'} onOpenChange={() => setModal(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Errores recientes</DialogTitle></DialogHeader>
          {recentErrors.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">Sin errores recientes.</p>
          ) : (
            <Table>
              <TableHeader><TableRow><TableHead>Fecha</TableHead><TableHead>Org</TableHead><TableHead>Tipo</TableHead><TableHead>Mensaje</TableHead></TableRow></TableHeader>
              <TableBody>
                {recentErrors.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(e.created_at)}</TableCell>
                    <TableCell className="text-sm">{e.organization_name}</TableCell>
                    <TableCell><ErrorTypeBadge type={e.error_type} /></TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-xs truncate">{e.error_message ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>

      {/* Balance tenants */}
      <Dialog open={modal === 'tenants'} onOpenChange={() => { setModal(null); setRechargeTarget(null); setRechargeAmount(''); }}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Balance por tenant</DialogTitle></DialogHeader>
          {tenantBalances.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">Sin datos.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organización</TableHead>
                  <TableHead className="text-right">Saldo USD</TableHead>
                  <TableHead>Saldo</TableHead>
                  <TableHead className="text-center">Activa</TableHead>
                  <TableHead className="text-center">Adjuntos</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenantBalances.map((t) => (
                  <>
                    <TableRow key={t.org_id} className={!t.is_active ? 'opacity-50' : ''}>
                      <TableCell className="text-sm">{t.name}</TableCell>
                      <TableCell className="text-right font-medium text-sm tabular-nums">${Number(t.balance).toFixed(2)}</TableCell>
                      <TableCell>
                        {t.balance === 0
                          ? <Badge variant="destructive">Sin saldo</Badge>
                          : t.balance < 10
                          ? <Badge variant="warning">Saldo bajo</Badge>
                          : <Badge variant="success">OK</Badge>
                        }
                      </TableCell>
                      <TableCell className="text-center">
                        <button
                          type="button"
                          disabled={togglingTenant === t.org_id}
                          onClick={() => handleToggleTenant(t)}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                            t.is_active ? 'bg-[#22C365]' : 'bg-slate-300'
                          } ${togglingTenant === t.org_id ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${t.is_active ? 'translate-x-4' : 'translate-x-0.5'}`} />
                        </button>
                      </TableCell>
                      <TableCell className="text-center">
                        <button
                          type="button"
                          disabled={togglingAttach === t.org_id}
                          onClick={() => handleToggleAttachExtraction(t)}
                          title={t.extract_attachments ? 'Extracción de adjuntos: ON' : 'Extracción de adjuntos: OFF'}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                            t.extract_attachments ? 'bg-[#22C365]' : 'bg-slate-300'
                          } ${togglingAttach === t.org_id ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${t.extract_attachments ? 'translate-x-4' : 'translate-x-0.5'}`} />
                        </button>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs"
                            onClick={() => { setRechargeTarget(t); setRechargeAmount(''); }}>
                            + Saldo
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs"
                            onClick={() => handleViewActivity(t)}>
                            Actividad
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                    {rechargeTarget?.org_id === t.org_id && (
                      <TableRow key={`${t.org_id}-recharge`} className="bg-muted/40">
                        <TableCell colSpan={5} className="py-3">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground flex-shrink-0">Agregar saldo a <strong>{t.name}</strong> (USD):</span>
                            <input
                              type="number"
                              min="0.01"
                              step="0.01"
                              placeholder="0.00"
                              value={rechargeAmount}
                              onChange={e => setRechargeAmount(e.target.value)}
                              onKeyDown={e => e.key === 'Enter' && handleRecharge()}
                              className="flex h-7 w-24 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              autoFocus
                            />
                            <Button size="sm" className="h-7 px-3" disabled={!rechargeAmount || recharging} onClick={handleRecharge}>
                              {recharging ? '...' : 'Confirmar'}
                            </Button>
                            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => { setRechargeTarget(null); setRechargeAmount(''); }}>
                              Cancelar
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>

      {/* Gestión de usuarios */}
      <Dialog open={modal === 'users'} onOpenChange={() => setModal(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Gestión de usuarios</DialogTitle>
          </DialogHeader>
          {usersError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 mt-2">
              Error al cargar usuarios: {usersError}
            </div>
          ) : adminUsers.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">Sin usuarios.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Organización</TableHead>
                  <TableHead>Registro</TableHead>
                  <TableHead className="text-center">Superadmin</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {adminUsers.map((u) => (
                  <TableRow key={u.user_id}>
                    <TableCell className="text-sm font-medium">{u.email}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{u.org_name ?? '—'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{formatDate(u.created_at)}</TableCell>
                    <TableCell className="text-center">
                      <button
                        type="button"
                        disabled={togglingUser === u.user_id}
                        onClick={() => handleToggleSuperadmin(u.user_id, u.is_superadmin)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                          u.is_superadmin ? 'bg-[#A347D1]' : 'bg-slate-300'
                        } ${togglingUser === u.user_id ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${u.is_superadmin ? 'translate-x-4' : 'translate-x-0.5'}`} />
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>

      {/* Actividad por tenant */}
      <Dialog open={modal === 'activity'} onOpenChange={() => { setModal('tenants'); setActivityTarget(null); }}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Actividad — {activityTarget?.name ?? ''}
              <span className="ml-2 text-sm font-normal text-muted-foreground">últimos 30 jobs</span>
            </DialogTitle>
          </DialogHeader>
          {loadingActivity ? (
            <div className="py-8 flex justify-center"><LoadingSpinner /></div>
          ) : activityError ? (
            <p className="text-sm text-destructive py-6 text-center">{activityError}</p>
          ) : tenantJobs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Este tenant todavía no registró procesos.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha</TableHead>
                  <TableHead>Origen</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Docs</TableHead>
                  <TableHead className="text-right">Procesados</TableHead>
                  <TableHead className="text-right">Fallidos</TableHead>
                  <TableHead className="text-right">Duración</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenantJobs.map((j) => {
                  const duration = j.finished_at
                    ? Math.round((new Date(j.finished_at).getTime() - new Date(j.created_at).getTime()) / 1000)
                    : null;
                  const sourceLabel: Record<string, string> = {
                    frontend_upload: 'Manual', integration_drive: 'Drive',
                    integration_remote: 'Integración', api_direct: 'API',
                  };
                  return (
                    <TableRow key={j.id}>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{formatDate(j.created_at)}</TableCell>
                      <TableCell className="text-xs">{sourceLabel[j.input_source ?? ''] ?? j.input_source ?? '—'}</TableCell>
                      <TableCell>
                        {(() => {
                          const t = j.total_documents ?? 0;
                          const f = j.failed_documents ?? 0;
                          const allFailed = (j.status === 'done' || j.status === 'done_with_warnings') && t > 0 && f >= t;
                          if (allFailed) return <Badge variant="destructive">Fallido</Badge>;
                          return j.status === 'done'
                            ? <Badge variant="success">Exitoso</Badge>
                            : j.status === 'done_with_warnings'
                            ? <Badge variant="warning">Con advertencia</Badge>
                            : j.status === 'error'
                            ? <Badge variant="destructive">{j.error_type === 'credits' ? 'Sin créditos' : 'Fallido'}</Badge>
                            : j.status === 'processing'
                            ? <Badge variant="secondary">Procesando</Badge>
                            : <Badge variant="outline">{j.status}</Badge>;
                        })()}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">{j.total_documents ?? '—'}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums">{j.processed_documents ?? '—'}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {j.failed_documents ? <span className="text-destructive">{j.failed_documents}</span> : '—'}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {duration != null ? `${duration}s` : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>

      {/* Worker health */}
      <Dialog open={modal === 'worker'} onOpenChange={() => setModal(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Worker — estado</DialogTitle></DialogHeader>
          <div className="space-y-3 mt-2">
            <div className={`rounded-lg border p-4 flex items-center gap-3 ${workerHealth.status === 'ok' ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
              <span className={`w-3 h-3 rounded-full flex-shrink-0 ${workerHealth.status === 'ok' ? 'bg-green-500' : workerHealth.status === 'checking' ? 'bg-slate-400 animate-pulse' : 'bg-red-500'}`} />
              <div>
                <p className={`text-sm font-semibold ${workerHealth.status === 'ok' ? 'text-green-800' : 'text-red-800'}`}>
                  {workerHealth.status === 'ok' ? 'Gateway online' : workerHealth.status === 'checking' ? 'Verificando...' : workerHealth.status === 'timeout' ? 'Timeout (>5s)' : 'Gateway offline'}
                </p>
                {workerHealth.status === 'ok' && (
                  <p className="text-xs text-green-700 mt-0.5">Latencia: {workerHealth.latency_ms}ms · Versión: {workerHealth.worker_version ?? '?'}</p>
                )}
              </div>
            </div>
            {workerHealth.status === 'ok' && (
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Google OAuth</p>
                  <p className="font-medium mt-0.5">{workerHealth.google_oauth ? '✅ Configurado' : '⚠️ Sin configurar'}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Versión</p>
                  <p className="font-mono font-medium mt-0.5">{workerHealth.worker_version ?? '—'}</p>
                </div>
              </div>
            )}
            <Button variant="outline" size="sm" className="w-full" onClick={checkWorkerHealth} disabled={workerHealth.status === 'checking'}>
              ↻ Verificar ahora
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Jobs trabados */}
      <Dialog open={modal === 'stuck'} onOpenChange={() => setModal(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Jobs trabados (&gt;20 min en processing)</DialogTitle></DialogHeader>
          {stuckJobs.length === 0 ? (
            <div className="flex items-center gap-2 py-6 text-green-700">
              <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
              <p className="text-sm font-medium">Sin jobs trabados. Todo procesando normalmente.</p>
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground mb-3">Podés marcar un job como fallido para liberarlo. El tenant verá el error en su panel.</p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Org</TableHead>
                    <TableHead>Creado</TableHead>
                    <TableHead className="text-right">Minutos</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stuckJobs.map((j) => (
                    <TableRow key={j.job_id}>
                      <TableCell className="text-sm">{j.org_name ?? '—'}</TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{formatDate(j.created_at)}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant={j.minutes_stuck > 60 ? 'destructive' : 'warning'}>{j.minutes_stuck} min</Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm" variant="destructive"
                          disabled={failingJob === j.job_id}
                          onClick={() => handleFailStuckJob(j.job_id)}
                        >
                          {failingJob === j.job_id ? '...' : 'Marcar fallido'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Cola — métricas BullMQ */}
      <Dialog open={modal === 'queue'} onOpenChange={() => setModal(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between">
              <span>Cola — métricas</span>
              <button
                type="button"
                onClick={fetchWorkerMetrics}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >↻ Actualizar</button>
            </DialogTitle>
          </DialogHeader>
          {metricsError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 mt-2">
              Error al obtener métricas: {metricsError}
            </div>
          ) : !workerMetrics ? (
            <div className="py-8 flex justify-center"><LoadingSpinner /></div>
          ) : (
            <div className="space-y-4 mt-2">
              {/* Queue depth */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Estado de la cola</p>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { label: 'Waiting',  value: workerMetrics.queue_depth.waiting,  color: workerMetrics.queue_depth.waiting > 10 ? '#f59e0b' : '#22C365' },
                    { label: 'Active',   value: workerMetrics.queue_depth.active,   color: '#22C365' },
                    { label: 'Delayed',  value: workerMetrics.queue_depth.delayed,  color: '#94a3b8' },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="rounded-lg border p-3 flex flex-col items-center text-center overflow-hidden relative">
                      <div className="absolute top-0 left-0 right-0 h-0.5" style={{ background: color }} />
                      <div className="text-2xl font-black font-lora mt-1">{value}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
                    </div>
                  ))}
                </div>
              </div>
              {/* Latency */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Latencia (últimos {workerMetrics.latency_ms.sample_size} jobs)</p>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { label: 'p50', value: workerMetrics.latency_ms.p50 },
                    { label: 'p95', value: workerMetrics.latency_ms.p95 },
                    { label: 'avg', value: workerMetrics.latency_ms.avg },
                  ].map(({ label, value }) => (
                    <div key={label} className="rounded-lg border p-3 flex flex-col items-center text-center">
                      <div className="text-xl font-black font-lora">{value != null ? `${value}ms` : '—'}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
                    </div>
                  ))}
                </div>
              </div>
              {/* Totals + error rate */}
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg border p-3 flex flex-col items-center text-center">
                  <div className="text-xl font-black font-lora">{workerMetrics.totals.completed}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">Exitosos</div>
                </div>
                <div className="rounded-lg border p-3 flex flex-col items-center text-center">
                  <div className="text-xl font-black font-lora">{workerMetrics.totals.failed}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">Fallidos</div>
                </div>
                <div className={`rounded-lg border p-3 flex flex-col items-center text-center ${workerMetrics.error_rate_pct > 5 ? 'border-red-200 bg-red-50' : ''}`}>
                  <div className={`text-xl font-black font-lora ${workerMetrics.error_rate_pct > 5 ? 'text-red-700' : ''}`}>{workerMetrics.error_rate_pct}%</div>
                  <div className="text-xs text-muted-foreground mt-0.5">Error rate</div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground text-right">
                Actualizado: {new Date(workerMetrics.timestamp).toLocaleTimeString('es-AR')} · {workerMetrics.worker_version}
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Precios */}
      <Dialog open={modal === 'prices'} onOpenChange={() => setModal(null)}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Editor de precios</DialogTitle></DialogHeader>

          <div className="space-y-6 mt-2">

            {/* Precio base por plan */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Precio base por documento (USD)</p>
              <div className="rounded-md border overflow-hidden">
                {pricingPlans.map((plan, i) => {
                  const key = `plan_${plan.name}`;
                  const editVal = editPrices[key];
                  const isDirty = editVal !== undefined;
                  return (
                    <div key={plan.name} className={`flex items-center gap-3 px-3 py-2.5 ${i < pricingPlans.length - 1 ? 'border-b' : ''}`}>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{plan.display_name}</p>
                        <p className="text-xs text-muted-foreground">{plan.docs_included.toLocaleString('es')} docs · paquete USD {Number(plan.balance_usd).toFixed(0)}</p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">$</span>
                        <input
                          type="number" step="0.01" min="0"
                          value={editVal ?? Number(plan.price_per_doc).toFixed(4)}
                          onChange={e => setEditPrices(prev => ({ ...prev, [key]: e.target.value }))}
                          className="w-24 h-7 rounded-md border border-input bg-background px-2 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                        <Button size="sm" className="h-7 px-2.5 text-xs" disabled={!isDirty || savingPrice === key} onClick={() => handleSavePlanPrice(plan.name)}>
                          {savingPrice === key ? '...' : 'Guardar'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Integraciones de almacenamiento */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Integraciones (USD adicional/doc)</p>
              <div className="space-y-3">

                {/* Google Drive agrupado */}
                {(() => {
                  const driveFeats = pricingFeatures.filter(f => f.feature_key.startsWith('integration_drive'));
                  if (driveFeats.length === 0) return null;
                  return (
                    <div className="rounded-md border overflow-hidden">
                      <div className="px-3 py-2 bg-muted/40 border-b flex items-center gap-2">
                        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="text-muted-foreground flex-shrink-0">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"/>
                        </svg>
                        <span className="text-xs font-semibold">Google Drive</span>
                      </div>
                      {driveFeats.map((feat, i) => (
                        <FeatureRow
                          key={feat.feature_key}
                          feat={feat}
                          editPrices={editPrices}
                          setEditPrices={setEditPrices}
                          savingPrice={savingPrice}
                          onSave={handleSaveFeatureCost}
                          indent={feat.feature_key !== 'integration_drive'}
                          border={i < driveFeats.length - 1}
                        />
                      ))}
                    </div>
                  );
                })()}

                {/* Otras integraciones */}
                {(() => {
                  const others = pricingFeatures.filter(f =>
                    f.feature_key.startsWith('integration_') && !f.feature_key.startsWith('integration_drive')
                  );
                  if (others.length === 0) return null;
                  return (
                    <div className="rounded-md border overflow-hidden">
                      {others.map((feat, i) => (
                        <FeatureRow
                          key={feat.feature_key}
                          feat={feat}
                          editPrices={editPrices}
                          setEditPrices={setEditPrices}
                          savingPrice={savingPrice}
                          onSave={handleSaveFeatureCost}
                          border={i < others.length - 1}
                        />
                      ))}
                    </div>
                  );
                })()}

              </div>
            </div>

            {/* Features adicionales */}
            {(() => {
              const extras = pricingFeatures.filter(f => !f.feature_key.startsWith('integration_'));
              if (extras.length === 0) return null;
              return (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Features adicionales (USD/doc)</p>
                  <div className="rounded-md border overflow-hidden">
                    {extras.map((feat, i) => (
                      <FeatureRow
                        key={feat.feature_key}
                        feat={feat}
                        editPrices={editPrices}
                        setEditPrices={setEditPrices}
                        savingPrice={savingPrice}
                        onSave={handleSaveFeatureCost}
                        border={i < extras.length - 1}
                      />
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">El costo total por doc = precio base del plan + suma de adicionales de features activas.</p>
                </div>
              );
            })()}

            {/* Intervalos de polling */}
            {pollingTiers.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Intervalos de escucha (USD adicional/doc)</p>
                <div className="rounded-md border overflow-hidden">
                  {/* Header */}
                  <div className="grid grid-cols-2 divide-x border-b bg-muted/40">
                    {[0, 1].map(col => (
                      <div key={col} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2 px-3 py-1.5">
                        <p className="text-xs font-semibold text-muted-foreground">Intervalo</p>
                        <p className="text-xs font-semibold text-muted-foreground w-9 text-center">Activo</p>
                        <p className="text-xs font-semibold text-muted-foreground w-24 text-right">+$/doc</p>
                        <p className="text-xs font-semibold text-muted-foreground w-16"></p>
                      </div>
                    ))}
                  </div>
                  {/* Rows — 2 columns */}
                  {Array.from({ length: Math.ceil(pollingTiers.length / 2) }, (_, rowIdx) => (
                    <div key={rowIdx} className={`grid grid-cols-2 divide-x ${rowIdx < Math.ceil(pollingTiers.length / 2) - 1 ? 'border-b' : ''}`}>
                      {[0, 1].map(col => {
                        const tier = pollingTiers[rowIdx * 2 + col];
                        if (!tier) return <div key={col} className="px-3 py-2" />;
                        const key = `poll_${tier.interval_minutes}`;
                        const editVal = editPollingTiers[key];
                        const isDirty = editVal !== undefined;
                        return (
                          <div key={tier.interval_minutes} className={`grid grid-cols-[1fr_auto_auto_auto] items-center gap-2 px-3 py-2 ${!tier.active ? 'opacity-50' : ''}`}>
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">{tier.label}</p>
                            </div>
                            {/* Toggle */}
                            <button
                              type="button"
                              disabled={togglingPollingTier === tier.interval_minutes}
                              onClick={() => handleTogglePollingTier(tier.interval_minutes, tier.active)}
                              title={tier.active ? 'Desactivar' : 'Activar'}
                              className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${
                                tier.active ? 'bg-[#22C365]' : 'bg-slate-300'
                              } ${togglingPollingTier === tier.interval_minutes ? 'opacity-50 cursor-not-allowed' : ''}`}
                            >
                              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${tier.active ? 'translate-x-4' : 'translate-x-0.5'}`} />
                            </button>
                            {/* Input */}
                            <div className="flex items-center gap-1">
                              <span className="text-xs text-muted-foreground">$</span>
                              <input
                                type="number" step="0.0001" min="0"
                                value={editVal ?? Number(tier.cost_per_doc).toFixed(4)}
                                onChange={e => setEditPollingTiers(prev => ({ ...prev, [key]: e.target.value }))}
                                className="w-20 h-7 rounded-md border border-input bg-background px-2 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              />
                            </div>
                            {/* Save */}
                            <Button
                              size="sm" className="h-7 px-2.5 text-xs w-16"
                              disabled={!isDirty || savingPollingTier === tier.interval_minutes}
                              onClick={() => handleSavePollingTierCost(tier.interval_minutes)}
                            >
                              {savingPollingTier === tier.interval_minutes ? '...' : 'Guardar'}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-2">Toggle para mostrar/ocultar el tramo en la UI del tenant. El costo se suma al total del job solo si el tenant usa ese intervalo.</p>
              </div>
            )}

          </div>
        </DialogContent>
      </Dialog>

      {/* Tipos de documento (TASK-111) */}
      <Dialog open={modal === 'doctypes'} onOpenChange={() => setModal(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Tipos de documento</DialogTitle></DialogHeader>

          <div className="space-y-4 mt-2">
            <p className="text-xs text-muted-foreground">
              Lista global de tipos. La <b>etiqueta</b> es lo que ve el usuario; el <b>codigo</b> es el valor que produce la IA y se guarda en los documentos. Es inmutable. Desactivar un tipo lo oculta del menu de edicion manual sin borrar datos.
            </p>

            <div className="rounded-md border overflow-hidden">
              {docTypes.length === 0 && (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">Sin tipos cargados.</div>
              )}
              {docTypes.map((dt, i) => {
                const editVal = editDocLabels[dt.code];
                const isDirty = editVal !== undefined && editVal.trim() !== dt.label && editVal.trim() !== '';
                return (
                  <div key={dt.code} className={`flex items-center gap-3 px-3 py-2.5 ${i < docTypes.length - 1 ? 'border-b' : ''} ${!dt.active ? 'opacity-50' : ''}`}>
                    <div className="flex-1 min-w-0">
                      <input
                        type="text"
                        value={editVal ?? dt.label}
                        onChange={e => setEditDocLabels(prev => ({ ...prev, [dt.code]: e.target.value }))}
                        className="w-full h-7 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      />
                      <p className="text-[11px] text-muted-foreground font-mono mt-0.5 truncate">{dt.code}</p>
                    </div>
                    <button
                      type="button"
                      disabled={togglingDocType === dt.code}
                      onClick={() => handleToggleDocType(dt.code, dt.active)}
                      title={dt.active ? 'Desactivar' : 'Activar'}
                      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${dt.active ? 'bg-[#22C365]' : 'bg-slate-300'} ${togglingDocType === dt.code ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${dt.active ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </button>
                    <Button size="sm" className="h-7 px-2.5 text-xs w-16" disabled={!isDirty || savingDocType === dt.code} onClick={() => handleSaveDocTypeLabel(dt.code)}>
                      {savingDocType === dt.code ? '...' : 'Guardar'}
                    </Button>
                  </div>
                );
              })}
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Agregar tipo nuevo</p>
              <div className="flex items-end gap-2">
                <div className="flex-1 min-w-0">
                  <label className="text-[11px] text-muted-foreground">Codigo (interno, p. ej. FACTURA_E)</label>
                  <input
                    type="text"
                    value={newDocCode}
                    onChange={e => setNewDocCode(e.target.value)}
                    placeholder="FACTURA_E"
                    className="w-full h-7 rounded-md border border-input bg-background px-2 text-sm font-mono uppercase focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <label className="text-[11px] text-muted-foreground">Etiqueta (visible)</label>
                  <input
                    type="text"
                    value={newDocLabel}
                    onChange={e => setNewDocLabel(e.target.value)}
                    placeholder="Factura E"
                    className="w-full h-7 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </div>
                <Button size="sm" className="h-7 px-3 text-xs" disabled={!newDocCode.trim() || !newDocLabel.trim() || addingDocType} onClick={handleAddDocType}>
                  {addingDocType ? '...' : 'Agregar'}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground mt-1.5">El codigo se normaliza a mayusculas. Solo crea un tipo si la IA puede producir ese valor; si no, no se asignara automaticamente a ningun documento.</p>
            </div>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}

