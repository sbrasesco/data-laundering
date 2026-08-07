/**
 * poller-handoff.mjs — Módulo compartido para pollers de integración
 * Data Laundering V2.0
 *
 * Principio: los pollers solo saben CÓMO obtener el archivo de su fuente.
 * Todo lo que ocurre después (SHA256, dedup, upload a Aurora, encolar en gateway)
 * es responsabilidad de este módulo.
 *
 * Exports:
 *   SUPPORTED_EXTENSIONS      — extensiones válidas con file_type y mime
 *   callRpc                   — fetch a RPC de Aurora (Supabase interno)
 *   checkAndRegisterFile      — SHA256 + dedup (devuelve { isNew })
 *   uploadAndEnqueue          — upload a Aurora + enqueue en gateway
 *   handoffBuffer             — wrapper conveniente: checkAndRegisterFile + uploadAndEnqueue
 *   runIntegrationPoller      — orquestador genérico (get integrations → poll → update)
 *
 * Flujo recomendado para pollers que necesitan mover archivos según resultado:
 *   1. download buffer
 *   2. checkAndRegisterFile → si !isNew: mover a procesados/ (ya fue procesado antes)
 *   3. Si isNew: mover a en_proceso/
 *   4. uploadAndEnqueue (con fileMeta que incluye original_path = en_proceso/{filename})
 *   5. Worker mueve de en_proceso/ → procesados/ o fallidos/ según resultado
 */

import crypto from 'node:crypto';
import path   from 'node:path';

// ─── Constantes compartidas ───────────────────────────────────────────────────

export const SUPPORTED_EXTENSIONS = {
  '.pdf':  { file_type: 'pdf', mime: 'application/pdf' },
  '.jpg':  { file_type: 'jpg', mime: 'image/jpeg' },
  '.jpeg': { file_type: 'jpg', mime: 'image/jpeg' },
  '.png':  { file_type: 'png', mime: 'image/png' },
  '.zip':  { file_type: 'zip', mime: 'application/zip' },
  '.rar':  { file_type: 'rar', mime: 'application/x-rar-compressed' },
};

// ─── Aurora helpers ───────────────────────────────────────────────────────────

export async function callRpc(supabaseUrl, supabaseKey, rpcName, params = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${rpcName}`, {
    method: 'POST',
    headers: {
      'apikey':        supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RPC ${rpcName} failed (${res.status}): ${text}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ─── Guard de saldo (POLLER-BALANCE-GUARD) ───────────────────────────────────

// Mismo umbral que gateway.mjs:handleEnqueue (por debajo responde 402 INSUFFICIENT_CREDITS).
export const MIN_PROCESSING_BALANCE = 1;

/**
 * Chequea si la org tiene saldo suficiente para procesar (>= MIN_PROCESSING_BALANCE).
 * Fail-open: ante error del chequeo devuelve ok=true (mismo criterio que el gateway)
 * para no frenar integraciones por un fallo transitorio del check.
 */
export async function orgHasProcessingCredits(orgId, ctx) {
  const { supabaseUrl, supabaseKey, log } = ctx;
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/organization_credits?organization_id=eq.${encodeURIComponent(orgId)}&select=balance`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } },
    );
    if (!res.ok) throw new Error(`organization_credits query failed (${res.status})`);
    const rows    = await res.json();
    const balance = Number(rows?.[0]?.balance ?? 0);
    return { ok: balance >= MIN_PROCESSING_BALANCE, balance };
  } catch (err) {
    log('warn', 'poller.credits_check_failed', { organization_id: orgId, error: err.message });
    return { ok: true, balance: null };
  }
}

// ─── Paso 1: SHA256 + deduplicación ──────────────────────────────────────────

/**
 * Verifica si el archivo ya fue procesado y lo registra si es nuevo.
 * Los pollers llaman esto ANTES de mover el archivo a en_proceso/.
 *
 * @returns {{ isNew: boolean }}
 */
export async function checkAndRegisterFile({ buffer, filename, orgId, integrationId, ctx }) {
  const { supabaseUrl, supabaseKey } = ctx;
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
  const isNew    = await callRpc(supabaseUrl, supabaseKey, 'admin_register_processed_file', {
    p_integration_id:  integrationId,
    p_organization_id: orgId,
    p_file_hash:       fileHash,
    p_filename:        filename,
  });
  return { isNew: !!isNew };
}

// ─── Paso 2: Upload a Aurora + enqueue en gateway ─────────────────────────────

/**
 * Sube el buffer a Aurora Storage y encola el job en el gateway.
 * Se llama DESPUÉS de mover el archivo a en_proceso/ en el storage del cliente.
 * fileMeta se embebe en el metadata del job y lo usa integration-file-mover.mjs
 * para mover el archivo a procesados/ o fallidos/ cuando el worker termina.
 *
 * @param {Object} fileMeta  — datos específicos del protocolo para mover el archivo:
 *   Supabase Storage: { original_path, bucket_name }
 *   Firebase Storage: { original_path, bucket_name }
 *   Google Drive:     { drive_file_id, en_proceso_folder_id, client_folder_id }
 */
export async function uploadAndEnqueue({ buffer, filename, orgId, integrationId, protocol, pollingIntervalMinutes = null, fileMeta = {}, ctx }) {
  const { supabaseUrl, supabaseKey, gatewayUrl, gatewayApiKey, log } = ctx;

  const ext     = path.extname(filename).toLowerCase();
  const extInfo = SUPPORTED_EXTENSIONS[ext];
  if (!extInfo) throw new Error(`Extensión no soportada: ${ext}`);

  // Upload a Aurora Storage (bucket documents propio de Aurora).
  // Sanear el nombre para la CLAVE de storage: espacios y caracteres no URL-safe rompen la URL
  // publica que se le pasa a Mistral (400 "File could not be fetched"). El nombre REAL se conserva
  // aparte en original_filename (para mostrar). Solo afecta la ruta interna de Aurora.
  const safeName    = String(filename).replace(/\s+/g, '_').replace(/[^\w.\-]/g, '_');
  const uniqueName  = `${Date.now()}_${safeName}`;
  const storagePath = `${orgId}/integrations/${uniqueName}`;
  const uploadRes   = await fetch(`${supabaseUrl}/storage/v1/object/documents/${storagePath}`, {
    method:  'POST',
    headers: {
      'apikey':        supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type':  extInfo.mime,
      'x-upsert':      'false',
    },
    body: buffer,
  });
  if (!uploadRes.ok) {
    const txt = await uploadRes.text();
    throw new Error(`Aurora storage upload failed (${uploadRes.status}): ${txt}`);
  }
  const fileUrl = `${supabaseUrl}/storage/v1/object/public/documents/${storagePath}`;

  // Encolar en gateway — fileMeta queda en metadata para que integration-file-mover lo use
  const enqRes = await fetch(`${gatewayUrl}/api/enqueue`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${gatewayApiKey}`,
    },
    body: JSON.stringify({
      organization_id:        orgId,
      file_url:               fileUrl,
      file_type:              extInfo.file_type,
      original_filename:      filename,
      input_source:           protocol,
      polling_interval_minutes: pollingIntervalMinutes,
      metadata:               { source: protocol, integration_id: integrationId, protocol, ...fileMeta },
    }),
  });
  if (!enqRes.ok) {
    const txt = await enqRes.text();
    if (enqRes.status === 402) {
      // Carrera de saldo justo: el guard del ciclo pasó pero el gateway rechazó por saldo.
      // Error tipado para que el poller devuelva el archivo a la raíz (POLLER-BALANCE-GUARD).
      const err = new Error(`Gateway enqueue rechazado por saldo (402): ${txt}`);
      err.code = 'INSUFFICIENT_CREDITS';
      throw err;
    }
    throw new Error(`Gateway enqueue failed (${enqRes.status}): ${txt}`);
  }

  log('info', 'integration.file_enqueued', {
    integration_id: integrationId, filename, file_type: extInfo.file_type, protocol,
  });
  return { action: 'enqueued', fileType: extInfo.file_type };
}

// ─── Wrapper conveniente ──────────────────────────────────────────────────────

/**
 * Wrapper que combina checkAndRegisterFile + uploadAndEnqueue.
 * Útil cuando el poller no necesita el paso intermedio de mover a en_proceso/.
 * Para el flujo completo (con en_proceso/), usar las dos funciones por separado.
 */
export async function handoffBuffer({ buffer, filename, orgId, integrationId, protocol, pollingIntervalMinutes = null, fileMeta = {}, ctx }) {
  const { log } = ctx;
  const { isNew } = await checkAndRegisterFile({ buffer, filename, orgId, integrationId, ctx });
  if (!isNew) {
    log('debug', 'integration.file_skipped_duplicate', { integration_id: integrationId, filename, protocol });
    return { action: 'skipped', reason: 'duplicate' };
  }
  return await uploadAndEnqueue({ buffer, filename, orgId, integrationId, protocol, pollingIntervalMinutes, fileMeta, ctx });
}

// ─── Archivo rechazado → job fallido visible ────────────────────────

/**
 * Registra un archivo rechazado (formato no soportado, etc.) como un job pdf_jobs
 * fallido visible en el frontend (status='error', error_type='rejected', razón en
 * error_message). NO se cobra. Universal para toda integración. El move del archivo
 * a fallidos/ lo hace cada poller con su storage API. Best-effort: nunca lanza.
 */
export async function registerRejectedFile({ orgId, integrationId, protocol, filename, reason, clientId = null, ctx }) {
  const { supabaseUrl, supabaseKey, log } = ctx;
  try {
    const jobId = await callRpc(supabaseUrl, supabaseKey, 'gateway_register_rejected_file', {
      p_org_id:       orgId,
      p_input_source: protocol,
      p_filename:     filename,
      p_reason:       reason,
      p_client_id:    clientId,
    });
    log('info', 'integration.file_rejected', { integration_id: integrationId, filename, protocol, reason, job_id: jobId });
    return jobId;
  } catch (err) {
    log('warn', 'integration.reject_register_failed', { integration_id: integrationId, filename, protocol, error: err.message });
    return null;
  }
}

// ─── Orquestador genérico ─────────────────────────────────────────────────────

/**
 * Orquestador reutilizable para cualquier tipo de integración.
 *
 * 1. Llama admin_get_active_integrations para obtener integraciones "due"
 * 2. Para cada una: ejecuta pollFn(integration, ctx)
 * 3. Actualiza last_polled_at independientemente del resultado
 */
export async function runIntegrationPoller({ type, pollFn, ctx }) {
  const { supabaseUrl, supabaseKey, log } = ctx;

  let integrations;
  try {
    integrations = await callRpc(supabaseUrl, supabaseKey, 'admin_get_active_integrations', { p_type: type });
  } catch (err) {
    log('error', 'integration.rpc_error', { type, error: err.message });
    return;
  }

  if (!integrations?.length) {
    log('debug', 'integration.no_due_integrations', { type });
    return;
  }

  log('info', 'integration.poll_start', { type, count: integrations.length });

  for (const integration of integrations) {
    const { id: integrationId, organization_id: orgId } = integration;

    // POLLER-BALANCE-GUARD: sin saldo suficiente NO se toca ningún archivo del tenant
    // (quedan en la raíz). Un solo log por ciclo/integración; se actualiza last_polled
    // para mantener la cadencia del ciclo.
    const credits = await orgHasProcessingCredits(orgId, ctx);
    if (!credits.ok) {
      log('warn', 'poller.skip_no_credits', {
        integration_id: integrationId, organization_id: orgId, protocol: type, balance: credits.balance,
      });
      try {
        await callRpc(supabaseUrl, supabaseKey, 'admin_update_last_polled', { p_integration_id: integrationId });
      } catch (_) {}
      continue;
    }

    try {
      await pollFn(integration, ctx);
      await callRpc(supabaseUrl, supabaseKey, 'admin_update_last_polled', { p_integration_id: integrationId });
    } catch (err) {
      log('error', 'integration.tenant_error', {
        integration_id: integrationId, organization_id: orgId, protocol: type, error: err.message,
      });
      try {
        await callRpc(supabaseUrl, supabaseKey, 'admin_update_last_polled', { p_integration_id: integrationId });
      } catch (_) {}
    }
  }

  log('info', 'integration.poll_done', { type });
}
