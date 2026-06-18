/**
 * post-processor.mjs — TASK-36: Lógica post-extracción en el Worker
 * Data Laundering V2.0 — Fase 2
 *
 * Responsabilidades (DEC-007 — la DB es pasiva):
 * 1. Evaluar confianza y etiquetar documentos (LOW_CONFIDENCE, INCOMPLETE)
 * 2. Escribir audit log por documento en pdf_document_audit_log
 * 3. Finalizar el job en pdf_jobs (done / done_with_warnings / error)
 *
 * Testeable, observable y versionada (DEC-011: N8N eliminado).
 */

import { depositOutputIfConfigured } from './output-depositor.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WORKER_VERSION = process.env.WORKER_VERSION ?? '0.6.0';

const CONFIDENCE_THRESHOLD = 0.8;

function supabaseHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer': 'return=minimal',
  };
}

// Mapeo input_source → feature_key (los precios viven en feature_pricing_multipliers en DB)
const INPUT_SOURCE_TO_FEATURE = {
  integration_drive:  'integration_drive',
  ftp:                'integration_ftp',
  sftp:               'integration_sftp',
  firebase_storage:   'integration_firebase',
};

async function fetchJobInputSource(jobId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/pdf_jobs?id=eq.${encodeURIComponent(jobId)}&select=input_source&limit=1`,
      { headers: supabaseHeaders() }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.[0]?.input_source ?? null;
  } catch {
    return null;
  }
}

// ─── 1. Evaluación de confianza y etiquetado ──────────────────────────────────

function evaluateExtraction(result) {
  const confidence = result.confidence_score ?? 0;
  const lowConfidence = confidence < CONFIDENCE_THRESHOLD;
  const incomplete = !!result.tipo_documento && !result.total && !result.numero_comprobante;

  let tag = null;
  if (lowConfidence) tag = 'LOW_CONFIDENCE';
  else if (incomplete) tag = 'INCOMPLETE';

  return { tag, needsReview: lowConfidence || incomplete, confidence };
}

// ─── 2. Proceso de un documento individual post-extracción ────────────────────

/**
 * Procesa el resultado de un documento después de document-processor.
 * - Evalúa confianza
 * - Marca el row en pdf_job_rows si es LOW_CONFIDENCE o INCOMPLETE
 * - Escribe audit log
 *
 * Best-effort: si algo falla, loguea pero no rompe el job.
 */
export async function processDocumentResult(result, jobId, orgId, log) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  if (!result?.success || !result?.row_id) return;

  const { row_id } = result;
  const { tag, confidence } = evaluateExtraction(result);

  // ── Marcar row si tiene baja confianza o incompleto ───────────────────────
  if (tag) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/pdf_job_rows?id=eq.${encodeURIComponent(row_id)}`, {
        method: 'PATCH',
        headers: supabaseHeaders(),
        body: JSON.stringify({ last_error_message: tag }),
      });
      log('info', 'post.row_tagged', { job_id: jobId, row_id, tag, confidence });
    } catch (err) {
      log('warn', 'post.row_tag_failed', { job_id: jobId, row_id, error: err.message });
    }
  }

  // ── Audit log ─────────────────────────────────────────────────────────────
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/pdf_document_audit_log`, {
      method: 'POST',
      headers: supabaseHeaders(),
      body: JSON.stringify({
        document_row_id: row_id,
        event_type: tag ?? 'completed',
        payload: JSON.stringify({
          job_id: jobId,
          confidence_score: result.confidence_score,
          tipo_documento: result.tipo_documento,
          numero_comprobante: result.numero_comprobante,
          total: result.total,
          worker_version: WORKER_VERSION,
        }),
        created_by: `worker:${WORKER_VERSION}`,
      }),
    });
    log('info', 'post.audit_logged', { job_id: jobId, row_id, event: tag ?? 'completed' });
  } catch (err) {
    log('warn', 'post.audit_failed', { job_id: jobId, row_id, error: err.message });
  }
}

// ─── 3. Finalización del job ──────────────────────────────────────────────────

/**
 * Finaliza el job en pdf_jobs después de procesar todos los documentos.
 * Determina si fue done o done_with_warnings basado en los resultados.
 *
 * Best-effort: si falla el UPDATE, loguea pero no relanza.
 */
export async function finalizeJob(jobId, orgId, { total, successful, failed, lowConfidence, pollingIntervalMinutes = null }, log) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;

  // Los contadores in-memory (failed, successful) solo reflejan errores de API.
  // Los triggers de DB (classify_pdf_job_row + sync_job_document_counts) son la
  // fuente de verdad sobre calidad de datos. Leer desde la DB para no pisarlos.
  let okRows = 0, warnRows = 0, failedRows = failed, ocRelations = 0;
  try {
    const rowsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/pdf_job_rows?job_id=eq.${encodeURIComponent(jobId)}&select=id,doc_status`,
      { headers: supabaseHeaders() }
    );
    if (rowsRes.ok) {
      const rows = await rowsRes.json();
      okRows     = rows.filter(r => r.doc_status === 'ok' || r.doc_status === 'pending_approval').length;
      warnRows   = rows.filter(r => r.doc_status === 'warning').length;
      failedRows = rows.filter(r => r.doc_status === 'failed').length;

      if (rows.length > 0) {
        const rowIds = rows.map(r => r.id).join(',');
        const ocRes = await fetch(
          `${SUPABASE_URL}/rest/v1/pdf_job_row_oc?row_id=in.(${rowIds})&select=id`,
          { method: 'HEAD', headers: { ...supabaseHeaders(), 'Prefer': 'count=exact' } }
        );
        const contentRange = ocRes.headers.get('content-range');
        if (contentRange) {
          const match = contentRange.match(/\/(\d+)$/);
          if (match) ocRelations = parseInt(match[1], 10);
        }
      }
    }
    log('info', 'post.row_counts', { job_id: jobId, ok: okRows, warn: warnRows, failed: failedRows, oc: ocRelations });
  } catch (err) {
    log('warn', 'post.row_counts_failed', { job_id: jobId, error: err.message, note: 'Usando contadores in-memory como fallback' });
  }

  const hasWarnings = failedRows > 0 || warnRows > 0 || lowConfidence > 0;
  const status = hasWarnings ? 'done_with_warnings' : 'done';

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/pdf_jobs?id=eq.${encodeURIComponent(jobId)}`,
      {
        method: 'PATCH',
        headers: supabaseHeaders(),
        body: JSON.stringify({
          status,
          total_documents:     okRows + warnRows + failedRows + ocRelations,
          processed_documents: okRows + warnRows + ocRelations,
          failed_documents:    failedRows,
          oc_relations:        ocRelations,
          finished_at:         new Date().toISOString(),
        }),
      }
    );

    if (res.ok) {
      log('info', 'post.job_finalized', { job_id: jobId, status, ok: okRows, warn: warnRows, failed: failedRows, lowConfidence, oc_relations: ocRelations });
    } else {
      const errText = await res.text();
      log('warn', 'post.job_finalize_failed', { job_id: jobId, http_status: res.status, error: errText });
    }
  } catch (err) {
    log('warn', 'post.job_finalize_error', { job_id: jobId, error: err.message });
  }

  // ── TASK-65: Depósito automático de CSV en integración de salida ─────────
  // Best-effort: si falla no afecta el job.
  const depositResult = await depositOutputIfConfigured(jobId, orgId, log);
  const outputFeatures = depositResult?.outputFeatures ?? [];

  // ── TASK-75: Detectar features activas para multiplicador de créditos ─────
  const inputSource = await fetchJobInputSource(jobId);
  const inputFeature = inputSource ? (INPUT_SOURCE_TO_FEATURE[inputSource] ?? null) : null;
  const activeFeatures = [...new Set([inputFeature, ...outputFeatures].filter(Boolean))];

  // ── TASK-18: Descuento de créditos post-procesamiento ─────────────────────
  // Orden: procesar → finalizar job → descontar crédito. Nunca al revés.
  // Si falla el descuento, NO revertir el procesamiento (el cliente ya tiene el resultado).
  const docsToCharge = okRows + warnRows + ocRelations;
  if (orgId && docsToCharge > 0) {
    try {
      const chargeRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/charge_credit`, {
        method: 'POST',
        headers: supabaseHeaders(),
        body: JSON.stringify({
          p_organization_id:          orgId,
          p_job_id:                   jobId,
          p_amount:                   docsToCharge,
          p_description:              `Job procesado: ${successful} facturas + ${ocRelations} OCs`,
          p_features:                 activeFeatures,
          p_polling_interval_minutes: pollingIntervalMinutes,
        }),
      });
      const charged = await chargeRes.json();
      if (charged === true) {
        log('info', 'post.credits_charged', { job_id: jobId, organization_id: orgId, amount: docsToCharge });
      } else {
        // Saldo insuficiente — loguear deuda pero no revertir
        log('warn', 'post.credits_insufficient', { job_id: jobId, organization_id: orgId, amount: docsToCharge });
      }
    } catch (err) {
      log('warn', 'post.credits_charge_failed', { job_id: jobId, organization_id: orgId, error: err.message });
    }
  }
}

/**
 * Marca el job como error cuando el Worker falla después de agotar los retries.
 */
export async function failJob(jobId, errorMessage, log, errorType = 'processing') {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;

  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/pdf_jobs?id=eq.${encodeURIComponent(jobId)}`,
      {
        method: 'PATCH',
        headers: supabaseHeaders(),
        body: JSON.stringify({
          status: 'error',
          error_message: errorMessage,
          error_type: errorType,
          finished_at: new Date().toISOString(),
        }),
      }
    );
    log('error', 'post.job_failed', { job_id: jobId, error: errorMessage, error_type: errorType });
  } catch (err) {
    log('warn', 'post.job_fail_error', { job_id: jobId, error: err.message });
  }
}
