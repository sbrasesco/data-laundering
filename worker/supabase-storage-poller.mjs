/**
 * supabase-storage-poller.mjs — Poller de integraciones Supabase Storage
 * Data Laundering V2.0 — TASK-106
 *
 * Este archivo solo contiene lógica específica de Supabase Storage:
 *   - listar archivos en raíz del bucket del cliente (excluye carpetas de sistema)
 *   - descargar archivos
 *   - mover a en_proceso/ cuando se levanta
 *   - el worker mueve a procesados/ o fallidos/ cuando termina (integration-file-mover.mjs)
 *
 * Estructura de carpetas en bucket del cliente:
 *   raíz/            → usuario suelta archivos acá
 *   en_proceso/      → poller mueve acá al levantar
 *   procesados/      → worker mueve acá si procesó OK
 *   fallidos/        → worker mueve acá si falló
 *   extracciones/    → worker deposita CSV resultante (output-depositor.mjs)
 *
 * Credenciales en tenant_integrations.credentials:
 *   { project_url, service_role_key, bucket_name }
 *
 * folder_path viene de integration.folder_path (columna top-level), NO de credentials.
 */

import path from 'node:path';
import {
  SUPPORTED_EXTENSIONS,
  checkAndRegisterFile,
  uploadAndEnqueue,
  runIntegrationPoller,
} from './poller-handoff.mjs';

// Carpetas de sistema — nunca se procesan como archivos entrantes
const SYSTEM_FOLDERS = new Set(['en_proceso', 'procesados', 'fallidos', 'extracciones']);

// ─── Cliente Supabase Storage del tenant ─────────────────────────────────────

function clientHeaders(serviceRoleKey) {
  return {
    'Authorization': `Bearer ${serviceRoleKey}`,
    'apikey':        serviceRoleKey,
    'Content-Type':  'application/json',
  };
}

async function listBucketFiles(projectUrl, serviceRoleKey, bucketName, prefix) {
  const res = await fetch(`${projectUrl}/storage/v1/object/list/${bucketName}`, {
    method: 'POST',
    headers: clientHeaders(serviceRoleKey),
    body: JSON.stringify({ prefix: prefix || '', limit: 200, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Supabase list failed (${res.status}): ${t}`); }
  return res.json();
}

async function downloadBucketFile(projectUrl, serviceRoleKey, bucketName, fullPath) {
  const res = await fetch(
    `${projectUrl}/storage/v1/object/authenticated/${bucketName}/${fullPath}`,
    { headers: { 'Authorization': `Bearer ${serviceRoleKey}`, 'apikey': serviceRoleKey } },
  );
  if (!res.ok) { const t = await res.text(); throw new Error(`Supabase download failed (${res.status}): ${t}`); }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Mueve un archivo dentro del mismo bucket. Best-effort: loguea warn si falla.
 */
async function moveFile(projectUrl, serviceRoleKey, bucketName, sourceKey, destKey, log, context = '') {
  try {
    const res = await fetch(`${projectUrl}/storage/v1/object/move`, {
      method:  'POST',
      headers: clientHeaders(serviceRoleKey),
      body: JSON.stringify({ bucketId: bucketName, sourceKey, destinationBucket: bucketName, destinationKey: destKey }),
    });
    if (!res.ok) { const t = await res.text(); throw new Error(`Move failed (${res.status}): ${t}`); }
    log('info', 'integration.file_moved', { protocol: 'supabase_storage', from: sourceKey, to: destKey, context });
  } catch (err) {
    log('warn', 'integration.file_move_failed', { protocol: 'supabase_storage', from: sourceKey, to: destKey, error: err.message });
  }
}

// ─── Poller específico ────────────────────────────────────────────────────────

async function pollSupabaseStorage(integration, ctx) {
  const { id: integrationId, organization_id: orgId, credentials, folder_path: folderPath,
          polling_interval_minutes: pollingIntervalMinutes } = integration;
  const { log } = ctx;

  const { project_url: projectUrl, service_role_key: serviceRoleKey, bucket_name: bucketName } = credentials ?? {};
  if (!projectUrl || !serviceRoleKey || !bucketName) {
    throw new Error('Supabase Storage: project_url, service_role_key y bucket_name son requeridos');
  }

  // Prefix normalizado: strip leading slash — Supabase Storage no usa leading slash
  const rawFolder = (folderPath ?? '').trim().replace(/^\/+/, '');
  const prefix    = rawFolder ? (rawFolder.endsWith('/') ? rawFolder : `${rawFolder}/`) : '';

  const allFiles = await listBucketFiles(projectUrl, serviceRoleKey, bucketName, prefix);

  // Filtrar: solo archivos reales con extensión soportada, excluir carpetas de sistema
  const candidates = allFiles.filter(f => {
    if (!f.name || f.metadata === null) return false; // directorio placeholder
    const topLevel = f.name.split('/')[0];
    if (SYSTEM_FOLDERS.has(topLevel)) return false;   // carpeta de sistema
    return !!SUPPORTED_EXTENSIONS[path.extname(f.name).toLowerCase()];
  });

  log('info', 'integration.files_found', {
    integration_id: integrationId, protocol: 'supabase_storage', count: candidates.length,
  });

  let enqueued = 0, skipped = 0, failed = 0;

  for (const file of candidates) {
    const fullPath     = prefix ? `${prefix}${file.name}` : file.name;
    const filename     = path.basename(file.name);
    const enProcesoKey = `${prefix}en_proceso/${filename}`;

    try {
      // 1. Descargar desde raíz
      const buffer = await downloadBucketFile(projectUrl, serviceRoleKey, bucketName, fullPath);

      // 2. Dedup check
      const { isNew } = await checkAndRegisterFile({ buffer, filename, orgId, integrationId, ctx });

      if (!isNew) {
        // Duplicado — borrar de raíz (ya existe en procesados/ del ciclo anterior, move daría 409)
        try {
          const delRes = await fetch(
            `${projectUrl}/storage/v1/object/${bucketName}/${encodeURIComponent(fullPath)}`,
            { method: 'DELETE', headers: { 'Authorization': `Bearer ${serviceRoleKey}`, 'apikey': serviceRoleKey } },
          );
          if (!delRes.ok) throw new Error(`${delRes.status}`);
          log('info', 'integration.duplicate_deleted_from_root', {
            integration_id: integrationId, filename, protocol: 'supabase_storage',
          });
        } catch (err) {
          log('warn', 'integration.duplicate_delete_failed', {
            integration_id: integrationId, filename, protocol: 'supabase_storage', error: err.message,
          });
        }
        skipped++;
        continue;
      }

      // 3. Nuevo: mover a en_proceso/
      await moveFile(projectUrl, serviceRoleKey, bucketName, fullPath, enProcesoKey, log, 'to_en_proceso');

      // 4. Upload a Aurora + enqueue — fileMeta permite que el worker lo mueva después
      await uploadAndEnqueue({
        buffer, filename, orgId, integrationId, protocol: 'supabase_storage',
        pollingIntervalMinutes,
        fileMeta: { original_path: enProcesoKey, bucket_name: bucketName },
        ctx,
      });
      enqueued++;

    } catch (fileErr) {
      log('error', 'integration.file_error', {
        integration_id: integrationId, filename, protocol: 'supabase_storage', error: fileErr.message,
      });
      failed++;
    }
  }

  log('info', 'integration.tenant_done', {
    integration_id: integrationId, organization_id: orgId, protocol: 'supabase_storage', enqueued, skipped, failed,
  });
}

// ─── Export ───────────────────────────────────────────────────────────────────

export async function pollSupabaseStorageIntegrations(ctx) {
  await runIntegrationPoller({ type: 'supabase_storage', pollFn: pollSupabaseStorage, ctx });
}
