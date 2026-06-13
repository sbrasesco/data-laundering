import { useState, useEffect, useCallback } from 'react';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { supabase } from '../lib/supabase';

// ─── Types ────────────────────────────────────────────────────────────────────
interface JobSummary    { status: string; error_type: string | null; count: number; }
interface RecentError   { id: string; organization_name: string | null; error_type: string | null; error_message: string | null; created_at: string; }
interface TenantBalance { org_id: string; name: string; balance: number; }
interface DocsStats     { total_processed: number; processed_24h: number; }
interface AdminUser     { user_id: string; email: string; org_id: string | null; org_name: string | null; is_superadmin: boolean; created_at: string; }
interface StuckJob      { job_id: string; org_name: string | null; created_at: string; minutes_stuck: number; }
interface WorkerHealth  { status: 'ok' | 'error' | 'timeout' | 'checking'; worker_version?: string; google_oauth?: boolean; latency_ms?: number; }

type ModalKey = 'jobs' | 'docs' | 'errors' | 'tenants' | 'users' | 'worker' | 'stuck' | null;

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
      <div className="text-3xl font-black tracking-tight">{metric}</div>
      <div className="text-xs font-semibold uppercase tracking-wide mt-1 text-muted-foreground">{title}</div>
      <div className="text-xs text-muted-foreground/70 mt-0.5">{sub}</div>
      <div className="absolute bottom-2 right-3 text-[10px] text-muted-foreground/40 group-hover:text-muted-foreground/70 transition-colors">Ver →</div>
    </button>
  );
}

// ─── SVG icons ────────────────────────────────────────────────────────────────
const IconJobs    = () => <svg width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>;
const IconDocs    = () => <svg width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>;
const IconErrors  = () => <svg width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>;
const IconTenants = () => <svg width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>;
const IconUsers   = () => <svg width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>;
const IconWorker  = () => <svg width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path strokeLinecap="round" strokeLinejoin="round" d="M8 21h8M12 17v4"/><circle cx="12" cy="10" r="2" fill="currentColor" stroke="none"/></svg>;
const IconStuck   = () => <svg width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline strokeLinecap="round" strokeLinejoin="round" points="12 6 12 12 16 14"/></svg>;

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
  const [failingJob,     setFailingJob]     = useState<string | null>(null);
  const [rechargeTarget, setRechargeTarget] = useState<TenantBalance | null>(null);
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [recharging,     setRecharging]     = useState(false);
  const [loading,        setLoading]        = useState(true);
  const [lastUpdated,    setLastUpdated]    = useState<Date | null>(null);
  const [modal,          setModal]          = useState<ModalKey>(null);
  const [togglingUser,   setTogglingUser]   = useState<string | null>(null);

  const GATEWAY_BASE = (import.meta.env.VITE_GATEWAY_BASE_URL as string) ?? '';

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

      // Balance por tenant
      const { data: creditsData } = await supabase.from('organization_credits').select('organization_id, balance');
      const creditOrgIds = (creditsData ?? []).map((c) => c.organization_id);
      const { data: creditOrgsData } = await supabase.from('organizations').select('id, name').in('id', creditOrgIds);
      const creditOrgNames: Record<string, string> = {};
      for (const o of creditOrgsData ?? []) creditOrgNames[o.id] = o.name;
      setTenantBalances(
        (creditsData ?? []).map((c) => ({ org_id: c.organization_id, name: creditOrgNames[c.organization_id] ?? c.organization_id?.slice(0, 8) + '…', balance: c.balance ?? 0 }))
          .sort((a, b) => a.balance - b.balance)
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

  useEffect(() => { fetchData(); checkWorkerHealth(); }, [fetchData, checkWorkerHealth]);

  const handleRecharge = async () => {
    if (!rechargeTarget) return;
    const amount = parseInt(rechargeAmount, 10);
    if (!amount || isNaN(amount)) return;
    setRecharging(true);
    try {
      const { data: newBalance, error } = await supabase.rpc('add_credits_admin', { p_org_id: rechargeTarget.org_id, p_amount: amount });
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
          </div>
        </>
      )}

      {/* ── Modales ──────────────────────────────────────────────────────────── */}

      {/* Jobs */}
      <Dialog open={modal === 'jobs'} onOpenChange={() => setModal(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Jobs — detalle</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3 mt-2">
            {[
              { label: 'Total', value: totalJobs, color: '#000000' },
              { label: 'Completados', value: completedJobs, color: '#22C365' },
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
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Balance por tenant</DialogTitle></DialogHeader>
          {tenantBalances.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">Sin datos.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organización</TableHead>
                  <TableHead className="text-right">Créditos</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenantBalances.map((t) => (
                  <>
                    <TableRow key={t.org_id}>
                      <TableCell className="text-sm">{t.name}</TableCell>
                      <TableCell className="text-right font-medium text-sm tabular-nums">{t.balance.toLocaleString()}</TableCell>
                      <TableCell>
                        {t.balance === 0
                          ? <Badge variant="destructive">Sin saldo</Badge>
                          : t.balance < 10
                          ? <Badge variant="warning">Saldo bajo</Badge>
                          : <Badge variant="success">OK</Badge>
                        }
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm" variant="outline"
                          className="h-7 px-2 text-xs"
                          onClick={() => { setRechargeTarget(t); setRechargeAmount(''); }}
                        >
                          + Créditos
                        </Button>
                      </TableCell>
                    </TableRow>
                    {rechargeTarget?.org_id === t.org_id && (
                      <TableRow key={`${t.org_id}-recharge`} className="bg-muted/40">
                        <TableCell colSpan={4} className="py-3">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground flex-shrink-0">Agregar créditos a <strong>{t.name}</strong>:</span>
                            <input
                              type="number"
                              min="1"
                              placeholder="Cantidad"
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

    </div>
  );
}
