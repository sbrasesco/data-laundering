/**
 * integration-poller.mjs — Poller de integraciones (Google Drive)
 * Data Laundering V2.0 — TASK-39
 *
 * Flujo por integración activa:
 *   1. Obtiene integraciones "due" via admin_get_active_integrations()
 *   2. Para google_drive: usa Service Account para listar archivos nuevos
 *   3. Descarga cada archivo → sube a Supabase Storage
 *   4. POST al Input Gateway para encolar el job
 *   5. Registra file_hash para deduplicación
 *   6. Actualiza last_polled_at
 */

import crypto from 'node:crypto';
import { google } from 'googleapis';

const SUPPORTED_MIME_TYPES = {
  'application/pdf':  { ext: 'pdf',  file_type: 'pdf'  },
  'image/jpeg':       { ext: 'jpg',  file_type: 'jpg'  },
  'image/png':        { ext: 'png',  file_type: 'png'  },
  'application/zip':  { ext: 'zip',  file_type: 'zip'  },
  'application/x-zip-compressed': { ext: 'zip', file_type: 'zip' },
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
  return res.json();
}

async function uploadToStorage(supabaseUrl, supabaseKey, orgId, filename, buffer, mimeType) {
  const path = `${orgId}/integrations/${filename}`;
  const res = await fetch(
    `${supabaseUrl}/storage/v1/object/documents/${path}`,
    {
      method: 'POST',
      headers: {
        'apikey':         supabaseKey,
        'Authorization':  `Bearer ${supabaseKey}`,
        'Content-Type':   mimeType,
        'x-upsert':       'false',
      },
      body: buffer,
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Storage upload failed (${res.status}): ${text}`);
  }
  // Retorna la URL pública del archivo
  return `${supabaseUrl}/storage/v1/object/public/documents/${path}`;
}

async function enqueueJob(gatewayUrl, orgId, fileUrl, fileType, filename, integrationId) {
  const res = await fetch(`${gatewayUrl}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      organization_id:   orgId,
      file_url:          fileUrl,
      file_type:         fileType,
      original_filename: filename,
      metadata: {
        source:         'integration_drive',
        integration_id: integrationId,
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gateway enqueue failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ─── Google Drive helpers ────────────────────────────────────────────────────

function buildDriveClient(serviceAccountJson) {
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccountJson,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return google.drive({ version: 'v3', auth });
}

async function listNewFiles(drive, folderId, sinceDate) {
  const query = [
    `'${folderId}' in parents`,
    `trashed = false`,
    sinceDate
      ? `modifiedTime > '${sinceDate.toISOString()}'`
      : null,
  ].filter(Boolean).join(' and ');

  const res = await drive.files.list({
    q: query,
    fields: 'files(id, name, mimeType, size, modifiedTime)',
    orderBy: 'modifiedTime asc',
    pageSize: 100,
  });

  return (res.data.files || []).filter(f => SUPPORTED_MIME_TYPES[f.mimeType]);
}

async function downloadFile(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data);
}

// ─── Poller principal ────────────────────────────────────────────────────────

export async function pollGoogleDriveIntegrations({ supabaseUrl, supabaseKey, gatewayUrl, log }) {
  // 1. Obtener integraciones google_drive "due" (last_polled_at + interval < now)
  let integrations;
  try {
    integrations = await callRpc(supabaseUrl, supabaseKey, 'admin_get_active_integrations', {
      p_type: 'google_drive',
    });
  } catch (err) {
    log('error', 'integration.rpc_error', { error: err.message });
    return;
  }

  if (!integrations || integrations.length === 0) {
    log('debug', 'integration.no_due_integrations', { type: 'google_drive' });
    return;
  }

  log('info', 'integration.poll_start', { type: 'google_drive', count: integrations.length });

  for (const integration of integrations) {
    const { id: integrationId, organization_id: orgId, credentials, last_polled_at } = integration;

    log('info', 'integration.tenant_start', { integration_id: integrationId, organization_id: orgId });

    try {
      // Validar credenciales
      if (!credentials?.service_account_json || !credentials?.folder_id) {
        log('warn', 'integration.missing_credentials', { integration_id: integrationId });
        await callRpc(supabaseUrl, supabaseKey, 'admin_update_last_polled', { p_integration_id: integrationId });
        continue;
      }

      const serviceAccountJson = typeof credentials.service_account_json === 'string'
        ? JSON.parse(credentials.service_account_json)
        : credentials.service_account_json;
      const folderId = credentials.folder_id;

      // 2. Conectar a Drive
      const drive = buildDriveClient(serviceAccountJson);

      // 3. Listar archivos nuevos desde last_polled_at
      const sinceDate = last_polled_at ? new Date(last_polled_at) : null;
      const files = await listNewFiles(drive, folderId, sinceDate);

      log('info', 'integration.files_found', {
        integration_id: integrationId,
        count: files.length,
        since: sinceDate?.toISOString() ?? 'all',
      });

      let enqueued = 0, skipped = 0, failed = 0;

      for (const file of files) {
        try {
          // 4. Descargar archivo
          const buffer = await downloadFile(drive, file.id);

          // 5. Calcular hash para deduplicación
          const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

          // 6. Verificar si ya fue procesado
          const isNew = await callRpc(supabaseUrl, supabaseKey, 'admin_register_processed_file', {
            p_integration_id:  integrationId,
            p_organization_id: orgId,
            p_file_hash:       fileHash,
            p_filename:        file.name,
          });

          if (!isNew) {
            log('debug', 'integration.file_skipped_duplicate', {
              integration_id: integrationId,
              filename: file.name,
              file_hash: fileHash,
            });
            skipped++;
            continue;
          }

          // 7. Subir a Supabase Storage
          const uniqueName = `${Date.now()}_${file.name}`;
          const fileUrl = await uploadToStorage(
            supabaseUrl, supabaseKey,
            orgId, uniqueName,
            buffer, file.mimeType
          );

          // 8. Encolar en Input Gateway
          const fileType = SUPPORTED_MIME_TYPES[file.mimeType].file_type;
          await enqueueJob(gatewayUrl, orgId, fileUrl, fileType, file.name, integrationId);

          log('info', 'integration.file_enqueued', {
            integration_id: integrationId,
            filename: file.name,
            file_type: fileType,
            file_hash: fileHash,
          });
          enqueued++;

        } catch (fileErr) {
          log('error', 'integration.file_error', {
            integration_id: integrationId,
            filename: file.name,
            error: fileErr.message,
          });
          failed++;
          // Continúa con el siguiente archivo — un fallo no detiene el lote
        }
      }

      // 9. Actualizar last_polled_at
      await callRpc(supabaseUrl, supabaseKey, 'admin_update_last_polled', { p_integration_id: integrationId });

      log('info', 'integration.tenant_done', {
        integration_id: integrationId,
        organization_id: orgId,
        enqueued,
        skipped,
        failed,
      });

    } catch (tenantErr) {
      log('error', 'integration.tenant_error', {
        integration_id: integrationId,
        organization_id: orgId,
        error: tenantErr.message,
      });
      // Intentar actualizar last_polled_at igual para no quedar en loop infinito
      try {
        await callRpc(supabaseUrl, supabaseKey, 'admin_update_last_polled', { p_integration_id: integrationId });
      } catch (_) {}
    }
  }

  log('info', 'integration.poll_done', { type: 'google_drive' });
}
