import { useState, useEffect, useCallback } from 'react';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { supabase } from '../lib/supabase';

interface JobSummary   { status: string; error_type: string | null; count: number; }
interface RecentError  { id: string; organization_name: string | null; error_type: string | null; error_message: string | null; created_at: string; }
interface TenantBalance{ name: string; balance: number; }
interface DocsStats    { total_processed: number; processed_24h: number; }
interface AdminUser    { user_id: string; email: string; org_id: string | null; org_name: string | null; is_superadmin: boolean; created_at: string; }

function StatCard({ label, value, sub, accent = '#22C365' }: { label: string; value: number | string; sub?: string; accent?: string }) {
  return (
    <Card className="flex-1 text-center overflow-hidden" style={{ minWidth: '150px' }}>
      <div className="h-1.5 w-full" style={{ background: accent }} />
      <CardContent className="pt-4 pb-5">
        <div className="text-3xl font-bold tracking-tight">{value}</div>
        <div className="text-xs font-medium uppercase tracking-wide mt-1">{label}</div>
        {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function ErrorTypeBadge({ type }: { type: string | null }) {
  if (type === 'credits')    return <Badge variant="warning">💳 créditos</Badge>;
  if (type === 'processing') return <Badge variant="destructive">⚠️ sistema</Badge>;
  return <Badge variant="secondary">—</Badge>;
}

export function MonitoringPage() {
  const [jobSummary,     setJobSummary]     = useState<JobSummary[]>([]);
  const [recentErrors,   setRecentErrors]   = useState<RecentError[]>([]);
  const [tenantBalances, setTenantBalances] = useState<TenantBalance[]>([]);
  const [docsStats,      setDocsStats]      = useState<DocsStats>({ total_processed: 0, processed_24h: 0 });
  const [loading,        setLoading]        = useState(true);
  const [lastUpdated,    setLastUpdated]    = useState<Date | null>(null);
  const [adminUsers,     setAdminUsers]     = useState<AdminUser[]>([]);
  const [togglingUser,   setTogglingUser]   = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const { data: summaryData } = await supabase.from('pdf_jobs').select('status, error_type').then(({ data, error }) => {
        if (error) throw error;
        const counts: Record<string, number> = {};
        for (const row of data ?? []) {
          const key = `${row.status}__${row.error_type ?? 'null'}`;
          counts[key] = (counts[key] ?? 0) + 1;
        }
        return { data: Object.entries(counts).map(([key, count]) => { const [status, et] = key.split('__'); return { status, error_type: et === 'null' ? null : et, count }; }) };
      });
      setJobSummary(summaryData ?? []);

      const { data: errorsData } = await supabase.from('pdf_jobs').select('id, organization_id, error_type, error_message, created_at').eq('status', 'error').order('created_at', { ascending: false }).limit(10);
      const orgIds = [...new Set((errorsData ?? []).map((e) => e.organization_id))];
      const orgNames: Record<string, string> = {};
      if (orgIds.length > 0) { const { data: orgsData } = await supabase.from('organizations').select('id, name').in('id', orgIds); for (const o of orgsData ?? []) orgNames[o.id] = o.name; }
      setRecentErrors((errorsData ?? []).map((e) => ({ id: e.id, organization_name: orgNames[e.organization_id] ?? e.organization_id?.slice(0, 8) + '…', error_type: e.error_type, error_message: e.error_message, created_at: e.created_at })));

      const { data: creditsData } = await supabase.from('organization_credits').select('organization_id, balance');
      const creditOrgIds = (creditsData ?? []).map((c) => c.organization_id);
      const { data: creditOrgsData } = await supabase.from('organizations').select('id, name').in('id', creditOrgIds);
      const creditOrgNames: Record<string, string> = {};
      for (const o of creditOrgsData ?? []) creditOrgNames[o.id] = o.name;
      setTenantBalances((creditsData ?? []).map((c) => ({ name: creditOrgNames[c.organization_id] ?? c.organization_id?.slice(0, 8) + '…', balance: c.balance ?? 0 })).sort((a, b) => a.balance - b.balance));

      const { data: allJobs } = await supabase.from('pdf_jobs').select('processed_documents, created_at').in('status', ['done', 'done_with_warnings']);
      const now = Date.now(); const h24 = 86400000; let total = 0; let last24 = 0;
      for (const j of allJobs ?? []) { const docs = j.processed_documents ?? 0; total += docs; if (now - new Date(j.created_at).getTime() < h24) last24 += docs; }
      setDocsStats({ total_processed: total, processed_24h: last24 });
      const { data: usersData } = await supabase.rpc('get_all_users_admin');
      setAdminUsers((usersData ?? []) as AdminUser[]);

      setLastUpdated(new Date());
    } finally { setLoading(false); }
  }, []);

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

  useEffect(() => { fetchData(); }, [fetchData]);

  const totalJobs    = jobSummary.reduce((s, r) => s + r.count, 0);
  const completedJobs= jobSummary.filter((r) => r.status === 'done' || r.status === 'done_with_warnings').reduce((s, r) => s + r.count, 0);
  const errorCredits = jobSummary.filter((r) => r.status === 'error' && r.error_type === 'credits').reduce((s, r) => s + r.count, 0);
  const errorSystem  = jobSummary.filter((r) => r.status === 'error' && r.error_type === 'processing').reduce((s, r) => s + r.count, 0);
  const errorUnknown = jobSummary.filter((r) => r.status === 'error' && !r.error_type).reduce((s, r) => s + r.count, 0);
  const processing   = jobSummary.filter((r) => r.status === 'processing').reduce((s, r) => s + r.count, 0);
  const errorRate    = totalJobs > 0 ? Math.round(((errorSystem + errorUnknown) / totalJobs) * 100) : 0;
  const isCritical   = errorRate > 3;
  const isWarning    = errorRate >= 1 && errorRate <= 3;

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            <span className="inline-block px-2 py-0.5 rounded-lg" style={{ background: '#FED210', color: '#000000' }}>Monitoreo</span>
          </h1>
          <p className="text-sm text-muted-foreground">Estado general del sistema y errores recientes.</p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && <span className="text-xs text-muted-foreground">Actualizado: {lastUpdated.toLocaleTimeString('es-AR')}</span>}
          <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>{loading ? 'Actualizando…' : '↻ Actualizar'}</Button>
        </div>
      </div>

      {loading && !lastUpdated ? <LoadingSpinner /> : (
        <>
          {totalJobs > 0 && (
            <div className={`rounded-lg border px-4 py-3 text-sm font-medium flex items-center gap-2 ${isCritical ? 'border-red-200 bg-red-50 text-red-800' : isWarning ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-green-200 bg-green-50 text-green-800'}`}>
              {isCritical ? '🔴' : isWarning ? '🟡' : '🟢'}
              {isCritical ? `Sistema en estado crítico — tasa de error del sistema: ${errorRate}% (umbral: > 3%)` : isWarning ? `Atención requerida — tasa de error del sistema: ${errorRate}% (umbral: 1–3%)` : `Sistema saludable — tasa de error del sistema: ${errorRate}%`}
            </div>
          )}

          <div className="flex flex-wrap gap-4">
            <StatCard label="Jobs totales"     value={totalJobs}                   accent="#000000" />
            <StatCard label="Completados"      value={completedJobs}               accent="#22C365" />
            <StatCard label="En procesamiento" value={processing}                  accent="#FED210" />
            <StatCard label="Errores sistema"  value={errorSystem + errorUnknown}  accent="#e11d48" sub={`${errorRate}% tasa de error`} />
            <StatCard label="Errores créditos" value={errorCredits}                accent="#A347D1" sub="Responsabilidad del cliente" />
            <StatCard label="Docs procesados"  value={docsStats.total_processed}   accent="#22C365" sub={`${docsStats.processed_24h} en las últimas 24h`} />
          </div>

          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-base">Errores recientes</CardTitle></CardHeader>
            <CardContent>
              {recentErrors.length === 0 ? (
                <p className="text-sm text-muted-foreground">Sin errores recientes. ✅</p>
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
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-base">Balance por tenant</CardTitle></CardHeader>
            <CardContent>
              {tenantBalances.length === 0 ? (
                <p className="text-sm text-muted-foreground">Sin datos de créditos.</p>
              ) : (
                <Table>
                  <TableHeader><TableRow><TableHead>Organización</TableHead><TableHead className="text-right">Créditos</TableHead><TableHead>Estado</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {tenantBalances.map((t) => (
                      <TableRow key={t.name}>
                        <TableCell className="text-sm">{t.name}</TableCell>
                        <TableCell className="text-right font-medium text-sm tabular-nums">{t.balance.toLocaleString()}</TableCell>
                        <TableCell>
                          {t.balance === 0 ? <Badge variant="destructive">⛔ Sin saldo</Badge> : t.balance < 10 ? <Badge variant="warning">⚠️ Saldo bajo</Badge> : <Badge variant="success">✅ OK</Badge>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Gestión de usuarios</CardTitle>
                <span className="text-xs text-muted-foreground">{adminUsers.length} usuario{adminUsers.length !== 1 ? 's' : ''}</span>
              </div>
            </CardHeader>
            <CardContent>
              {adminUsers.length === 0 ? (
                <p className="text-sm text-muted-foreground">Sin usuarios.</p>
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
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
