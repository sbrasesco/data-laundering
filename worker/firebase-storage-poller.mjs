/**
 * firebase-storage-poller.mjs — Poller de integraciones Firebase Storage
 * Data Laundering V2.0 — TASK-71
 *
 * Flujo por integración activa:
 *   1. Obtiene integraciones "due" via admin_get_active_integrations()
 *   2. Inicializa firebase-admin con service_account_json de las credenciales
 *   3. Lista archivos en bucket/folder_path (excluye /procesados/)
 *   4. Descarga → SHA256 → dedup → Supabase Storage → Input Gateway
 *   5. Actualiza last_polled_at
 *
 * Credenciales esperadas en tenant_integrations.credentials:
 *   { service_account_json: Object|String, bucket_name: String, folder_path: String }
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

// ─── Supabase helpers ────────────────────────────────────────────────────────

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

async function uploadToStorage(supabaseUrl, supabaseKey, orgId, filename, buffer, mimeType) {
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
    throw new Error(`Storage upload failed (${res.status}): ${text}`);
  }
  return `${supabaseUrl}/storage/v1/object/public/documents/${storagePath}`;
}

async function enqueueJob(gatewayUrl, gatewayApiKey, orgId, fileUrl, fileType, filename, integrationId) {
  const res = await fetch(gatewayUrl, {
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
        protocol:       'firebase_storage',
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gateway enqueue failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ─── Firebase Storage poller ─────────────────────────────────────────────────

async function pollFirebaseStorage(integration, { supabaseUrl, supabaseKey, gatewayUrl, gatewayApiKey, log }) {
  const { id: integrationId, organization_id: orgId, credentials } = integration;

  // Parsear credenciales
  const serviceAccount = typeof credentials.service_account_json === 'string'
    ? JSON.parse(credentials.service_account_json)
    : credentials.service_account_json;

  const bucketName = credentials.bucket_name;
  const folderPath = credentials.folder_path || '';

  if (!serviceAccount || !bucketName) {
    throw new Error('Firebase Storage: service_account_json y bucket_name son requeridos');
  }

  // Inicializar app de Firebase con nombre único por integración
  // (firebase-admin permite múltiples apps nombradas)
  const { initializeApp, deleteApp, cert } = await import('firebase-admin/app');
  const { getStorage } = await import('firebase-admin/storage');

  const appName = `dl_integration_${integrationId}`;
  const app = initializeApp({
    credential: cert(serviceAccount),
    storageBucket: bucketName,
  }, appName);

  try {
    const bucket = getStorage(app).bucket();

    // Prefix = folder_path normalizado (con / al final)
    const prefix = folderPath
      ? (folderPath.endsWith('/') ? folderPath : `${folderPath}/`)
      : '';

    // Listar archivos — delimiter='/' lista solo el nivel inmediato del prefix
    const [files] = await bucket.getFiles({ prefix });

    // Filtrar: solo archivos con extensión soportada, excluir /procesados/
    const candidates = files.filter(f => {
      if (f.name.endsWith('/')) return false;                    // directorio placeholder
      if (f.name.includes('/procesados/')) return false;         // carpeta de salida
      const ext = path.extname(f.name).toLowerCase();
      return !!SUPPORTED_EXTENSIONS[ext];
    });

    log('info', 'integration.files_found', {
      integration_id: integrationId,
      protocol:       'firebase_storage',
      count:          candidates.length,
    });

    let enqueued = 0, skipped = 0, failed = 0;

    for (const file of candidates) {
      const filename = path.basename(file.name);
      try {
        // Descargar a Buffer
        const [buffer] = await file.download();

        // SHA256 + deduplicación
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
          });
          skipped++;
          continue;
        }

        // Subir a Supabase Storage
        const ext        = path.extname(filename).toLowerCase();
        const { file_type, mime } = SUPPORTED_EXTENSIONS[ext];
        const uniqueName = `${Date.now()}_${filename}`;
        const fileUrl    = await uploadToStorage(supabaseUrl, supabaseKey, orgId, uniqueName, buffer, mime);

        // Encolar en Input Gateway
        await enqueueJob(gatewayUrl, gatewayApiKey, orgId, fileUrl, file_type, filename, integrationId);

        log('info', 'integration.file_enqueued', {
          integration_id: integrationId,
          filename,
          file_type,
          protocol: 'firebase_storage',
        });
        enqueued++;

      } catch (fileErr) {
        log('error', 'integration.file_error', {
          integration_id: integrationId,
          filename,
          protocol: 'firebase_storage',
          error: fileErr.message,
        });
        failed++;
      }
    }

    log('info', 'integration.tenant_done', {
      integration_id:  integrationId,
      organization_id: orgId,
      protocol:        'firebase_storage',
      enqueued,
      skipped,
      failed,
    });

  } finally {
    // Liberar la app para evitar memory leaks
    await deleteApp(app);
  }
}

// ─── Orquestador ─────────────────────────────────────────────────────────────

export async function pollFirebaseStorageIntegrations({ supabaseUrl, supabaseKey, gatewayUrl, gatewayApiKey, log }) {
  let integrations;
  try {
    integrations = await callRpc(supabaseUrl, supabaseKey, 'admin_get_active_integrations', {
      p_type: 'firebase_storage',
    });
  } catch (err) {
    log('error', 'integration.rpc_error', { type: 'firebase_storage', error: err.message });
    return;
  }

  if (!integrations?.length) {
    log('debug', 'integration.no_due_integrations', { type: 'firebase_storage' });
    return;
  }

  log('info', 'integration.poll_start', { type: 'firebase_storage', count: integrations.length });

  for (const integration of integrations) {
    const { id: integrationId, organization_id: orgId } = integration;
    try {
      await pollFirebaseStorage(integration, { supabaseUrl, supabaseKey, gatewayUrl, gatewayApiKey, log });
      await callRpc(supabaseUrl, supabaseKey, 'admin_update_last_polled', {
        p_integration_id: integrationId,
      });
    } catch (tenantErr) {
      log('error', 'integration.tenant_error', {
        integration_id:  integrationId,
        organization_id: orgId,
        protocol:        'firebase_storage',
        error:           tenantErr.message,
      });
      try {
        await callRpc(supabaseUrl, supabaseKey, 'admin_update_last_polled', {
          p_integration_id: integrationId,
        });
      } catch (_) {}
    }
  }

  log('info', 'integration.poll_done', { type: 'firebase_storage' });
}
