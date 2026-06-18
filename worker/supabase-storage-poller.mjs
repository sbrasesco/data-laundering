/**
 * supabase-storage-poller.mjs — Poller de integraciones Supabase Storage
 * Data Laundering V2.0 — TASK-106
 *
 * Flujo por integración activa:
 *   1. Obtiene integraciones "due" via admin_get_active_integrations()
 *   2. Lista archivos en bucket/folder_path via Supabase Storage REST API
 *   3. Descarga → SHA256 → dedup → Aurora Storage (documents) → Input Gateway
 *   4. Mueve original a /procesados/ en el bucket del cliente (best-effort)
 *   5. Actualiza last_polled_at
 *
 * Credenciales esperadas en tenant_integrations.credentials:
 *   {
 *     project_url:      String  — ej: https://xxxxx.supabase.co
 *     service_role_key: String  — clave service_role del proyecto del cliente
 *     bucket_name:      String  — nombre del bucket donde sueltan los archivos
 *     folder_path?:     String  — carpeta dentro del bucket (opcional)
 *   }
 */

import crypto from 'node:crypto';
import path   from 'node:path';

const SUPPORTED_EXTENSIONS = {
  '.pdf':  { file_type: 'pdf', mime: 'application/pdf' },
  '.jpg':  { file_type: 'jpg', mime: 'image/jpeg' },
  '.jpeg': { file_type: 'jpg', mime: 'image/jpeg' },
  '.png':  { file_type: 'png', mime: 'image/png' },
  '.zip':  { file_type: 'zip', mime: 'application/zip' },
  '.rar':  { file_type: 'rar', mime: 'application/x-rar-compressed' },
};

// ─── Aurora helpers (Supabase interno de Aurora) ─────────────────────────────

async function callRpc(supabaseUrl, supabaseKey, rpcName, params = {}) {
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

async function uploadToAuroraStorage(supabaseUrl, supabaseKey, orgId, filename, buffer, mimeType) {
  const storagePath = `${orgId}/integrations/${filename}`;
  const res = await fetch(
    `${supabaseUrl}/storage/v1/object/documents/${storagePath}`,
    {
      method: 'POST',
      headers: {
        'apikey':        supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type':  mimeType,
        'x-upsert':      'false',
      },
      body: buffer,
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Aurora storage upload failed (${res.status}): ${text}`);
  }
  return `${supabaseUrl}/storage/v1/object/public/documents/${storagePath}`;
}

async function enqueueJob(gatewayUrl, gatewayApiKey, orgId, fileUrl, fileType, filename, integrationId) {
  const res = await fetch(`${gatewayUrl}/api/enqueue`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${gatewayApiKey}`,
    },
    body: JSON.stringify({
      organization_id:   orgId,
      file_url:          fileUrl,
      file_type:         fileType,
      original_filename: filename,
      input_source:      'integration_remote',
      metadata: {
        source:         'integration_remote',
        integration_id: integrationId,
        protocol:       'supabase_storage',
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gateway enqueue failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ─── Cliente Supabase Storage del tenant ─────────────────────────────────────

function clientHeaders(serviceRoleKey) {
  return {
    'Authorization': `Bearer ${serviceRoleKey}`,
    'apikey':        serviceRoleKey,
    'Content-Type':  'application/json',
  };
}

/**
 * Lista archivos en el bucket del cliente.
 * Retorna items con { name, id, metadata } donde name es el filename relativo al prefix.
 * Directorios/folders vienen con id=null y metadata=null.
 */
async function listBucketFiles(projectUrl, serviceRoleKey, bucketName, prefix) {
  const res = await fetch(
    `${projectUrl}/storage/v1/object/list/${bucketName}`,
    {
      method: 'POST',
      headers: clientHeaders(serviceRoleKey),
      body: JSON.stringify({
        prefix: prefix || '',
        limit:  200,
        offset: 0,
        sortBy: { column: 'name', order: 'asc' },
      }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase Storage list failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Descarga un archivo del bucket del cliente.
 * fullPath = prefix + filename, ej: "facturas/invoice.pdf"
 */
async function downloadBucketFile(projectUrl, serviceRoleKey, bucketName, fullPath) {
  const res = await fetch(
    `${projectUrl}/storage/v1/object/authenticated/${bucketName}/${fullPath}`,
    {
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey':        serviceRoleKey,
      },
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase Storage download failed (${res.status}): ${text}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Mueve un archivo a la subcarpeta /procesados/ usando la API de move de Supabase Storage.
 * Best-effort: loguea warn pero no lanza excepción.
 */
async function moveToProcessed(projectUrl, serviceRoleKey, bucketName, sourceKey, destKey, integrationId, filename, log) {
  try {
    const res = await fetch(
      `${projectUrl}/storage/v1/object/move`,
      {
        method: 'POST',
        headers: clientHeaders(serviceRoleKey),
        body: JSON.stringify({
          bucketId:          bucketName,
          sourceKey,
          destinationBucket: bucketName,
          destinationKey:    destKey,
        }),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Move failed (${res.status}): ${text}`);
    }
    log('info', 'integration.file_moved_to_procesados', {
      integration_id: integrationId,
      filename,
      protocol:       'supabase_storage',
      dest:           destKey,
    });
  } catch (moveErr) {
    log('warn', 'integration.file_move_failed', {
      integration_id: integrationId,
      filename,
      protocol:       'supabase_storage',
      error:          moveErr.message,
    });
  }
}

// ─── Poller principal ─────────────────────────────────────────────────────────

async function pollSupabaseStorage(integration, { supabaseUrl, supabaseKey, gatewayUrl, gatewayApiKey, log }) {
  const { id: integrationId, organization_id: orgId, credentials } = integration;

  const {
    project_url:      projectUrl,
    service_role_key: serviceRoleKey,
    bucket_name:      bucketName,
    folder_path:      folderPath,
  } = credentials ?? {};

  if (!projectUrl || !serviceRoleKey || !bucketName) {
    throw new Error('Supabase Storage: project_url, service_role_key y bucket_name son requeridos');
  }

  // Prefix normalizado (con / al final si existe)
  const prefix = folderPath
    ? (folderPath.endsWith('/') ? folderPath : `${folderPath}/`)
    : '';

  // Listar archivos del bucket del cliente
  const allFiles = await listBucketFiles(projectUrl, serviceRoleKey, bucketName, prefix);

  // Filtrar: solo extensiones soportadas, excluir directorios y /procesados/
  const candidates = allFiles.filter(f => {
    if (!f.name) return false;
    if (f.metadata === null) return false;          // directorio/folder placeholder
    if (f.name.includes('procesados')) return false; // ya procesados
    const ext = path.extname(f.name).toLowerCase();
    return !!SUPPORTED_EXTENSIONS[ext];
  });

  log('info', 'integration.files_found', {
    integration_id: integrationId,
    protocol:       'supabase_storage',
    count:          candidates.length,
  });

  let enqueued = 0, skipped = 0, failed = 0;

  for (const file of candidates) {
    // fullPath = path completo dentro del bucket (prefix + filename)
    const fullPath = prefix ? `${prefix}${file.name}` : file.name;
    const filename = path.basename(file.name);

    try {
      // Descargar a Buffer
      const buffer = await downloadBucketFile(projectUrl, serviceRoleKey, bucketName, fullPath);

      // SHA256 + deduplicación via Aurora
      const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
      const isNew = await callRpc(supabaseUrl, supabaseKey, 'admin_register_processed_file', {
        p_integration_id:  integrationId,
        p_organization_id: orgId,
        p_file_hash:       fileHash,
        p_filename:        filename,
      });

      if (!isNew) {
        log('debug', 'integration.file_skipped_duplicate', {
          integration_id: integrationId,
          filename,
          protocol:       'supabase_storage',
        });
        skipped++;
        continue;
      }

      // Subir a Aurora Storage (bucket documents)
      const ext = path.extname(filename).toLowerCase();
      const { file_type, mime } = SUPPORTED_EXTENSIONS[ext];
      const uniqueName = `${Date.now()}_${filename}`;
      const fileUrl = await uploadToAuroraStorage(supabaseUrl, supabaseKey, orgId, uniqueName, buffer, mime);

      // Encolar en Input Gateway
      await enqueueJob(gatewayUrl, gatewayApiKey, orgId, fileUrl, file_type, filename, integrationId);

      log('info', 'integration.file_enqueued', {
        integration_id: integrationId,
        filename,
        file_type,
        protocol:       'supabase_storage',
      });
      enqueued++;

      // Mover original a /procesados/ en el bucket del cliente (best-effort)
      const destKey = `${prefix}procesados/${filename}`;
      await moveToProcessed(
        projectUrl, serviceRoleKey, bucketName,
        fullPath, destKey,
        integrationId, filename, log
      );

    } catch (fileErr) {
      log('error', 'integration.file_error', {
        integration_id: integrationId,
        filename,
        protocol:       'supabase_storage',
        error:          fileErr.message,
      });
      failed++;
    }
  }

  log('info', 'integration.tenant_done', {
    integration_id:  integrationId,
    organization_id: orgId,
    protocol:        'supabase_storage',
    enqueued,
    skipped,
    failed,
  });
}

// ─── Orquestador ─────────────────────────────────────────────────────────────

export async function pollSupabaseStorageIntegrations({ supabaseUrl, supabaseKey, gatewayUrl, gatewayApiKey, log }) {
  let integrations;
  try {
    integrations = await callRpc(supabaseUrl, supabaseKey, 'admin_get_active_integrations', {
      p_type: 'supabase_storage',
    });
  } catch (err) {
    log('error', 'integration.rpc_error', { type: 'supabase_storage', error: err.message });
    return;
  }

  if (!integrations?.length) {
    log('debug', 'integration.no_due_integrations', { type: 'supabase_storage' });
    return;
  }

  log('info', 'integration.poll_start', { type: 'supabase_storage', count: integrations.length });

  for (const integration of integrations) {
    const { id: integrationId, organization_id: orgId } = integration;
    try {
      await pollSupabaseStorage(integration, { supabaseUrl, supabaseKey, gatewayUrl, gatewayApiKey, log });
      await callRpc(supabaseUrl, supabaseKey, 'admin_update_last_polled', {
        p_integration_id: integrationId,
      });
    } catch (tenantErr) {
      log('error', 'integration.tenant_error', {
        integration_id:  integrationId,
        organization_id: orgId,
        protocol:        'supabase_storage',
        error:           tenantErr.message,
      });
      try {
        await callRpc(supabaseUrl, supabaseKey, 'admin_update_last_polled', {
          p_integration_id: integrationId,
        });
      } catch (_) {}
    }
  }

  log('info', 'integration.poll_done', { type: 'supabase_storage' });
}
