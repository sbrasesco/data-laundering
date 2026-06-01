import { useState, useEffect, useCallback } from 'react';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { supabase } from '../lib/supabase';

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface JobSummary {
  status: string;
  error_type: string | null;
  count: number;
}

interface RecentError {
  id: string;
  organization_name: string | null;
  error_type: string | null;
  error_message: string | null;
  created_at: string;
}

interface TenantBalance {
  name: string;
  balance: number;
}

interface DocsStats {
  total_processed: number;
  processed_24h: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: number | string;
  sub?: string;
  color?: string;
}) {
  return (
    <div
      className="card"
      style={{
        flex: '1',
        minWidth: '180px',
        borderTop: color ? `3px solid ${color}` : undefined,
        textAlign: 'center',
        padding: '1.25rem',
      }}
    >
      <div style={{ fontSize: '2rem', fontWeight: 700, color: color ?? 'var(--color-text-primary)' }}>
        {value}
      </div>
      <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{label}</div>
      {sub && (
        <div style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>{sub}</div>
      )}
    </div>
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ErrorTypeBadge({ type }: { type: string | null }) {
  if (type === 'credits') {
    return (
      <span style={{
        background: '#fef9c3', color: '#854d0e',
        borderRadius: '6px', padding: '2px 8px', fontSize: '0.78rem', fontWeight: 600,
      }}>
        💳 créditos
      </span>
    );
  }
  if (type === 'processing') {
    return (
      <span style={{
        background: '#fee2e2', color: '#991b1b',
        borderRadius: '6px', padding: '2px 8px', fontSize: '0.78rem', fontWeight: 600,
      }}>
        ⚠️ sistema
      </span>
    );
  }
  return (
    <span style={{
      background: '#f4f4f5', color: '#71717a',
      borderRadius: '6px', padding: '2px 8px', fontSize: '0.78rem',
    }}>
      —
    </span>
  );
}

// ─── Página ───────────────────────────────────────────────────────────────────

export function MonitoringPage() {
  const [jobSummary, setJobSummary] = useState<JobSummary[]>([]);
  const [recentErrors, setRecentErrors] = useState<RecentError[]>([]);
  const [tenantBalances, setTenantBalances] = useState<TenantBalance[]>([]);
  const [docsStats, setDocsStats] = useState<DocsStats>({ total_processed: 0, processed_24h: 0 });
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // 1. Resumen de jobs por status y error_type
      const { data: summaryData } = await supabase
        .from('pdf_jobs')
        .select('status, error_type')
        .then(({ data, error }) => {
          if (error) throw error;
          // Agrupar en memoria
          const counts: Record<string, number> = {};
          for (const row of data ?? []) {
            const key = `${row.status}__${row.error_type ?? 'null'}`;
            counts[key] = (counts[key] ?? 0) + 1;
          }
          return {
            data: Object.entries(counts).map(([key, count]) => {
              const [status, error_type] = key.split('__');
              return { status, error_type: error_type === 'null' ? null : error_type, count };
            }),
          };
        });
      setJobSummary(summaryData ?? []);

      // 2. Errores recientes con nombre de organización
      const { data: errorsData } = await supabase
        .from('pdf_jobs')
        .select('id, organization_id, error_type, error_message, created_at')
        .eq('status', 'error')
        .order('created_at', { ascending: false })
        .limit(10);

      // Obtener nombres de orgs para los errores
      const orgIds = [...new Set((errorsData ?? []).map((e) => e.organization_id))];
      const orgNames: Record<string, string> = {};
      if (orgIds.length > 0) {
        const { data: orgsData } = await supabase
          .from('organizations')
          .select('id, name')
          .in('id', orgIds);
        for (const org of orgsData ?? []) {
          orgNames[org.id] = org.name;
        }
      }

      setRecentErrors(
        (errorsData ?? []).map((e) => ({
          id: e.id,
          organization_name: orgNames[e.organization_id] ?? e.organization_id?.slice(0, 8) + '…',
          error_type: e.error_type,
          error_message: e.error_message,
          created_at: e.created_at,
        }))
      );

      // 3. Balance por tenant
      const { data: creditsData } = await supabase
        .from('organization_credits')
        .select('organization_id, balance');

      const creditOrgIds = (creditsData ?? []).map((c) => c.organization_id);
      const { data: creditOrgsData } = await supabase
        .from('organizations')
        .select('id, name')
        .in('id', creditOrgIds);

      const creditOrgNames: Record<string, string> = {};
      for (const org of creditOrgsData ?? []) {
        creditOrgNames[org.id] = org.name;
      }

      setTenantBalances(
        (creditsData ?? [])
          .map((c) => ({
            name: creditOrgNames[c.organization_id] ?? c.organization_id?.slice(0, 8) + '…',
            balance: c.balance ?? 0,
          }))
          .sort((a, b) => a.balance - b.balance)
      );

      // 4. Docs procesados (total y últimas 24h)
      const { data: allJobs } = await supabase
        .from('pdf_jobs')
        .select('processed_documents, created_at')
        .in('status', ['done', 'done_with_warnings']);

      const now = Date.now();
      const h24 = 24 * 60 * 60 * 1000;
      let total = 0;
      let last24 = 0;
      for (const job of allJobs ?? []) {
        const docs = job.processed_documents ?? 0;
        total += docs;
        if (now - new Date(job.created_at).getTime() < h24) last24 += docs;
      }
      setDocsStats({ total_processed: total, processed_24h: last24 });

      setLastUpdated(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Calcular totales desde el resumen ─────────────────────────────────────
  const totalJobs = jobSummary.reduce((s, r) => s + r.count, 0);
  const completedJobs = jobSummary
    .filter((r) => r.status === 'done' || r.status === 'done_with_warnings')
    .reduce((s, r) => s + r.count, 0);
  const errorCredits = jobSummary
    .filter((r) => r.status === 'error' && r.error_type === 'credits')
    .reduce((s, r) => s + r.count, 0);
  const errorSystem = jobSummary
    .filter((r) => r.status === 'error' && r.error_type === 'processing')
    .reduce((s, r) => s + r.count, 0);
  const errorUnknown = jobSummary
    .filter((r) => r.status === 'error' && !r.error_type)
    .reduce((s, r) => s + r.count, 0);
  const processing = jobSummary
    .filter((r) => r.status === 'processing')
    .reduce((s, r) => s + r.count, 0);
  const errorRate = totalJobs > 0
    ? Math.round(((errorSystem + errorUnknown) / totalJobs) * 100)
    : 0;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0 }}>📊 Monitoreo</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {lastUpdated && (
            <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
              Actualizado: {lastUpdated.toLocaleTimeString('es-AR')}
            </span>
          )}
          <button className="btn btn-secondary" onClick={fetchData} disabled={loading}>
            {loading ? 'Actualizando…' : '↻ Actualizar'}
          </button>
        </div>
      </div>

      {loading && !lastUpdated ? (
        <LoadingSpinner />
      ) : (
        <>
          {/* ── Indicador de salud del sistema ── */}
          {totalJobs > 0 && (() => {
            const sysErrorRate = totalJobs > 0
              ? Math.round(((errorSystem + errorUnknown) / totalJobs) * 100)
              : 0;
            const isHealthy = sysErrorRate < 1;
            const isWarning = sysErrorRate >= 1 && sysErrorRate <= 3;
            const isCritical = sysErrorRate > 3;
            const bg = isCritical ? '#fee2e2' : isWarning ? '#fef9c3' : '#dcfce7';
            const color = isCritical ? '#991b1b' : isWarning ? '#854d0e' : '#166534';
            const icon = isCritical ? '🔴' : isWarning ? '🟡' : '🟢';
            const label = isCritical
              ? `Sistema en estado crítico — tasa de error del sistema: ${sysErrorRate}% (umbral: > 3%)`
              : isWarning
              ? `Atención requerida — tasa de error del sistema: ${sysErrorRate}% (umbral: 1–3%)`
              : `Sistema saludable — tasa de error del sistema: ${sysErrorRate}%`;
            return (
              <div style={{
                background: bg, color, borderRadius: '8px',
                padding: '0.75rem 1.25rem', marginBottom: '1.5rem',
                fontWeight: 600, fontSize: '0.95rem',
                display: 'flex', alignItems: 'center', gap: '0.5rem',
              }}>
                {icon} {label}
              </div>
            );
          })()}

          {/* ── Stat cards ── */}
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
            <StatCard label="Jobs totales" value={totalJobs} />
            <StatCard label="Completados" value={completedJobs} color="var(--color-success, #16a34a)" />
            <StatCard label="En procesamiento" value={processing} color="#2563eb" />
            <StatCard label="Errores sistema" value={errorSystem + errorUnknown}
              sub={`${errorRate}% tasa de error`} color="#dc2626" />
            <StatCard label="Errores créditos" value={errorCredits}
              sub="Responsabilidad del cliente" color="#d97706" />
            <StatCard label="Docs procesados" value={docsStats.total_processed}
              sub={`${docsStats.processed_24h} en las últimas 24h`} color="var(--color-primary)" />
          </div>

          {/* ── Errores recientes ── */}
          <div className="card" style={{ marginBottom: '1.5rem' }}>
            <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>Errores recientes</h2>
            {recentErrors.length === 0 ? (
              <p style={{ color: 'var(--color-text-secondary)' }}>Sin errores recientes. ✅</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid var(--color-border)' }}>
                      <th style={{ textAlign: 'left', padding: '0.5rem' }}>Fecha</th>
                      <th style={{ textAlign: 'left', padding: '0.5rem' }}>Org</th>
                      <th style={{ textAlign: 'left', padding: '0.5rem' }}>Tipo</th>
                      <th style={{ textAlign: 'left', padding: '0.5rem' }}>Mensaje</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentErrors.map((e) => (
                      <tr key={e.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                        <td style={{ padding: '0.5rem', whiteSpace: 'nowrap', color: 'var(--color-text-secondary)' }}>
                          {formatDate(e.created_at)}
                        </td>
                        <td style={{ padding: '0.5rem' }}>{e.organization_name}</td>
                        <td style={{ padding: '0.5rem' }}>
                          <ErrorTypeBadge type={e.error_type} />
                        </td>
                        <td style={{ padding: '0.5rem', color: 'var(--color-text-secondary)', maxWidth: '400px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {e.error_message ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Balance por tenant ── */}
          <div className="card">
            <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>Balance por tenant</h2>
            {tenantBalances.length === 0 ? (
              <p style={{ color: 'var(--color-text-secondary)' }}>Sin datos de créditos.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid var(--color-border)' }}>
                    <th style={{ textAlign: 'left', padding: '0.5rem' }}>Organización</th>
                    <th style={{ textAlign: 'right', padding: '0.5rem' }}>Créditos</th>
                    <th style={{ textAlign: 'left', padding: '0.5rem' }}>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {tenantBalances.map((t) => (
                    <tr key={t.name} style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <td style={{ padding: '0.5rem' }}>{t.name}</td>
                      <td style={{ padding: '0.5rem', textAlign: 'right', fontWeight: 600 }}>
                        {t.balance.toLocaleString()}
                      </td>
                      <td style={{ padding: '0.5rem' }}>
                        {t.balance === 0 ? (
                          <span style={{ color: '#dc2626', fontWeight: 600 }}>⛔ Sin saldo</span>
                        ) : t.balance < 10 ? (
                          <span style={{ color: '#d97706', fontWeight: 600 }}>⚠️ Saldo bajo</span>
                        ) : (
                          <span style={{ color: '#16a34a' }}>✅ OK</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
