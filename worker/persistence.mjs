/**
 * persistence.mjs — Sincronización de estados Worker → Supabase
 * Data Laundering V2.0 — TASK-28 / QUEUE-002-c
 *
 * Redis = fuente de verdad en tiempo real (BullMQ)
 * Supabase = historial auditable (queue_jobs + worker_events)
 *
 * Todas las operaciones son best-effort: si falla Supabase,
 * el Worker continúa procesando (el job en Redis no se pierde).
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WORKER_VERSION = process.env.WORKER_VERSION ?? '0.2.0';
const WORKER_ID = process.env.HOSTNAME ?? 'unknown';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUUID(v) { return UUID_RE.test(v); }

// Mapeo de estados BullMQ → enum queue_jobs
const STATE_MAP = {
  waiting:     'queued',
  prioritized: 'queued',
  active:      'processing',
  completed:   'completed',
  failed:      'failed',
  delayed:     'queued',
};

function headers() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer': 'return=minimal',
  };
}

/**
 * Crea o actualiza el registro en queue_jobs al recibir un job.
 * Upsert por pdf_job_id (UNIQUE constraint).
 */
export async function insertQueueJob(job, log) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  // Saltar jobs de test que no tienen UUID válido como job_id
  if (!isUUID(job.data.job_id)) {
    log('info', 'persistence.skip_test_job', { job_id: job.data.job_id, reason: 'not a valid UUID' });
    return;
  }
  try {
    // on_conflict va en URL query param, no en headers (PostgREST spec)
    const res = await fetch(`${SUPABASE_URL}/rest/v1/queue_jobs?on_conflict=pdf_job_id`, {
      method: 'POST',
      headers: {
        ...headers(),
        'Prefer': 'return=minimal,resolution=merge-duplicates',
      },
      body: JSON.stringify({
        pdf_job_id:      job.data.job_id,
        organization_id: job.data.organization_id,
        status:          'queued',
        priority:        job.data.priority ?? 5,
        attempts:        0,
        max_attempts:    job.opts?.attempts ?? 3,
        worker_id:       WORKER_ID,
        worker_version:  WORKER_VERSION,
        payload:         job.data,
        queued_at:       new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      log('warn', 'persistence.insert_failed', {
        job_id: job.data.job_id,
        http_status: res.status,
      });
    }
  } catch (err) {
    log('warn', 'persistence.insert_error', {
      job_id: job.data.job_id,
      error: err.message,
    });
  }
}

/**
 * Sincroniza el estado del job en queue_jobs y registra un evento en worker_events.
 * Llama en cada transición: active, completed, failed, dead.
 */
export async function syncJobState(job, event, extra = {}, log) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;

  const status = STATE_MAP[event] ?? event;
  const now = new Date().toISOString();
  const jobId = job?.data?.job_id;
  const orgId = job?.data?.organization_id;

  // Saltar jobs de test sin UUID válido
  if (!isUUID(jobId)) {
    log('info', 'persistence.skip_test_job', { job_id: jobId, transition: event });
    return;
  }

  const patch = {
    status,
    attempts:       job.attemptsMade ?? 0,
    worker_id:      WORKER_ID,
    worker_version: WORKER_VERSION,
    last_error:     job.failedReason ?? null,
  };

  if (event === 'active')     patch.started_at = now;
  if (event === 'completed')  patch.completed_at = now;
  if (event === 'failed' || event === 'dead') patch.completed_at = now;
  if (extra.result)           patch.result = extra.result;

  // ── UPDATE queue_jobs ──────────────────────────────────────────────────────
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/queue_jobs?pdf_job_id=eq.${encodeURIComponent(jobId)}`,
      { method: 'PATCH', headers: headers(), body: JSON.stringify(patch) }
    );
    if (!res.ok) {
      log('warn', 'persistence.sync_failed', { job_id: jobId, transition: event, http_status: res.status });
    }
  } catch (err) {
    log('warn', 'persistence.sync_error', { job_id: jobId, transition: event, error: err.message });
  }

  // ── INSERT worker_events ───────────────────────────────────────────────────
  try {
    const duration_ms = (event === 'completed' && job.processedOn)
      ? Date.now() - job.processedOn
      : null;

    const res = await fetch(`${SUPABASE_URL}/rest/v1/worker_events`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        queue_job_id:    null,        // se resuelve post-insert si se necesita
        organization_id: orgId,
        event,
        duration_ms,
        metadata: {
          worker_id:      WORKER_ID,
          worker_version: WORKER_VERSION,
          attempt:        job.attemptsMade,
          ...extra,
        },
        error: job.failedReason ?? null,
      }),
    });
    if (!res.ok) {
      log('warn', 'persistence.event_failed', { job_id: jobId, transition: event, http_status: res.status });
    }
  } catch (err) {
    log('warn', 'persistence.event_error', { job_id: jobId, transition: event, error: err.message });
  }
}
