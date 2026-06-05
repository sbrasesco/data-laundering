/**
 * post-processor.mjs — TASK-36: Lógica post-extracción en el Worker
 * Data Laundering V2.0 — Fase 2
 *
 * Responsabilidades (DEC-007 — la DB es pasiva):
 * 1. Evaluar confianza y etiquetar documentos (LOW_CONFIDENCE, INCOMPLETE)
 * 2. Escribir audit log por documento en pdf_document_audit_log
 * 3. Finalizar el job en pdf_jobs (done / done_with_warnings / error)
 *
 * Toda esta lógica vivía en múltiples nodos de n8n. Ahora está aquí:
 * testeable, observable y versionada.
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
 * Procesa el resultado de un documento después del sub-workflow n8n.
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
export async function finalizeJob(jobId, orgId, { total, successful, failed, lowConfidence }, log) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;

  const hasWarnings = failed > 0 || lowConfidence > 0;
  const status = hasWarnings ? 'done_with_warnings' : 'done';

  // Fix 2: COUNT(*) FROM pdf_job_row_oc WHERE row_id IN (SELECT id FROM pdf_job_rows WHERE job_id = ?)
  let ocRelations = 0;
  try {
    const rowsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/pdf_job_rows?job_id=eq.${encodeURIComponent(jobId)}&select=id`,
      { headers: supabaseHeaders() }
    );
    if (rowsRes.ok) {
      const rows = await rowsRes.json();
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
    log('info', 'post.oc_count', { job_id: jobId, oc_relations: ocRelations });
  } catch (err) {
    log('warn', 'post.oc_count_failed', { job_id: jobId, error: err.message });
  }

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/pdf_jobs?id=eq.${encodeURIComponent(jobId)}`,
      {
        method: 'PATCH',
        headers: supabaseHeaders(),
        body: JSON.stringify({
          status,
          total_documents: successful + ocRelations + failed,
          processed_documents: successful + ocRelations,
          failed_documents: failed,
          oc_relations: ocRelations,     // Fix 2: relaciones OC de pdf_job_row_oc
          finished_at: new Date().toISOString(),
        }),
      }
    );

    if (res.ok) {
      log('info', 'post.job_finalized', { job_id: jobId, status, total, successful, failed, lowConfidence, oc_relations: ocRelations });
    } else {
      const errText = await res.text();
      log('warn', 'post.job_finalize_failed', { job_id: jobId, http_status: res.status, error: errText });
    }
  } catch (err) {
    log('warn', 'post.job_finalize_error', { job_id: jobId, error: err.message });
  }

  // ── TASK-65: Depósito automático de CSV en integración de salida ─────────
  // Best-effort: si falla no afecta el job.
  await depositOutputIfConfigured(jobId, orgId, log);

  // ── TASK-18: Descuento de créditos post-procesamiento ─────────────────────
  // Orden: procesar → finalizar job → descontar crédito. Nunca al revés.
  // Si falla el descuento, NO revertir el procesamiento (el cliente ya tiene el resultado).
  const docsToCharge = successful + ocRelations;
  if (orgId && docsToCharge > 0) {
    try {
      const chargeRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/charge_credit`, {
        method: 'POST',
        headers: supabaseHeaders(),
        body: JSON.stringify({
          p_organization_id: orgId,
          p_job_id: jobId,
          p_amount: docsToCharge,
          p_description: `Job procesado: ${successful} facturas + ${ocRelations} OCs`,
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
