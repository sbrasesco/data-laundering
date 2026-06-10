/**
 * integration-poller.mjs — Poller de integraciones (Google Drive)
 * Data Laundering V2.0 — TASK-39 / TASK-70
 *
 * TASK-70: Migración a OAuth 2.0.
 *   - Si credentials.oauth_refresh_token → usa OAuth (nuevo)
 *   - Si credentials.service_account_json → usa Service Account (retrocompatibilidad)
 *
 * Flujo por integración activa:
 *   1. Obtiene integraciones "due" via admin_get_active_integrations()
 *   2. Para google_drive: autentica con OAuth o Service Account
 *   3. Lista TODOS los archivos de la carpeta (sin filtro modifiedTime)
 *   4. Deduplica por drive_file_id en integration_processed_files
 *   5. Descarga, sube a Supabase Storage y encola en Input Gateway
 *   6. Registra drive_file_id en integration_processed_files
 *   7. Borra el archivo de Drive (best-effort — Drive es solo inbox)
 *   8. Actualiza last_polled_at
 */

import { google } from 'googleapis';

const SUPPORTED_MIME_TYPES = {
  'application/pdf':           { ext: 'pdf', file_type: 'pdf' },
  'image/jpeg':                { ext: 'jpg', file_type: 'jpg' },
  'image/png':                 { ext: 'png', file_type: 'png' },
  'application/zip':           { ext: 'zip', file_type: 'zip' },
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
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function uploadToStorage(supabaseUrl, supabaseKey, orgId, filename, buffer, mimeType) {
  const path = `${orgId}/integrations/${filename}`;
  const res  = await fetch(
    `${supabaseUrl}/storage/v1/object/facturas/${path}`,
    {
      method:  'POST',
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
  return `${supabaseUrl}/storage/v1/object/public/facturas/${path}`;
}

function sanitizeStorageKey(filename) {
  return filename
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s$&+,/:;=?@"<>{}|\\^~[\]`]/g, '_');
}

async function enqueueJob(gatewayUrl, apiKey, orgId, fileUrl, fileType, filename, integrationId) {
  const res = await fetch(gatewayUrl, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      organization_id:   orgId,
      file_url:          fileUrl,
      file_type:         fileType,
      original_filename: filename,
      input_source:      'integration_drive',
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

// ─── Google Drive auth ───────────────────────────────────────────────────────

/**
 * LEGACY: Service Account (TASK-39).
 * Mantenido para retrocompatibilidad con integraciones existentes.
 */
function buildDriveClientServiceAccount(serviceAccountJson) {
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccountJson,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return google.drive({ version: 'v3', auth });
}

/**
 * NUEVO: OAuth 2.0 (TASK-70).
 * Usa refresh_token para obtener access_token fresco antes de cada poll.
 */
function buildDriveClientOAuth(refreshToken, clientId, clientSecret) {
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: 'v3', auth });
}

// ─── integration_processed_files helpers ─────────────────────────────────────

async function isDriveFileProcessed(supabaseUrl, supabaseKey, integrationId, driveFileId) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/integration_processed_files?integration_id=eq.${integrationId}&drive_file_id=eq.${encodeURIComponent(driveFileId)}&select=id&limit=1`,
    { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
  );
  if (!res.ok) return false;
  const rows = await res.json();
  return rows.length > 0;
}

async function registerDriveFileProcessed(supabaseUrl, supabaseKey, integrationId, orgId, driveFileId, filename) {
  await fetch(`${supabaseUrl}/rest/v1/integration_processed_files`, {
    method: 'POST',
    headers: {
      'apikey':          supabaseKey,
      'Authorization':  `Bearer ${supabaseKey}`,
      'Content-Type':   'application/json',
      'Prefer':         'return=minimal',
    },
    body: JSON.stringify({
      integration_id:    integrationId,
      organization_id:   orgId,
      drive_file_id:     driveFileId,
      original_filename: filename,
    }),
  });
}

// ─── Google Drive helpers ────────────────────────────────────────────────────

async function getOrCreateFolder(drive, parentFolderId, folderName) {
  const searchRes = await drive.files.list({
    q: `name='${folderName}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
  });
  if (searchRes.data.files?.length > 0) return searchRes.data.files[0].id;
  const createRes = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    },
    fields: 'id',
  });
  return createRes.data.id;
}

async function moveFileToProcesados(drive, fileId, parentFolderId, filename, integrationId, log) {
  try {
    const procesadosId = await getOrCreateFolder(drive, parentFolderId, 'procesados');
    await drive.files.update({
      fileId,
      addParents:    procesadosId,
      removeParents: parentFolderId,
      fields:        'id, parents',
    });
    log('info', 'integration.file_moved_to_procesados', {
      integration_id: integrationId,
      filename,
      drive_file_id:  fileId,
    });
  } catch (moveErr) {
    log('warn', 'integration.file_move_failed', {
      integration_id: integrationId,
      filename,
      drive_file_id:  fileId,
      error:          moveErr.message,
    });
  }
}

async function listAllFiles(drive, folderId) {
  const res = await drive.files.list({
    q:        `'${folderId}' in parents and trashed = false`,
    fields:   'files(id, name, mimeType, size)',
    orderBy:  'name asc',
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

export async function pollGoogleDriveIntegrations({ supabaseUrl, supabaseKey, gatewayUrl, gatewayApiKey, log }) {
  // 1. Obtener integraciones google_drive "due"
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
    const { id: integrationId, organization_id: orgId, credentials } = integration;

    log('info', 'integration.tenant_start', { integration_id: integrationId, organization_id: orgId });

    try {
      const folderId = credentials?.folder_id;
      if (!folderId) {
        log('warn', 'integration.missing_folder_id', { integration_id: integrationId });
        await callRpc(supabaseUrl, supabaseKey, 'admin_update_last_polled', { p_integration_id: integrationId });
        continue;
      }

      // 2. Construir cliente de Drive: OAuth (nuevo) o Service Account (legacy)
      let drive;

      if (credentials?.oauth_refresh_token) {
        // ── OAuth 2.0 (TASK-70) ──────────────────────────────────────────
        const clientId     = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
          log('error', 'integration.missing_google_oauth_env', { integration_id: integrationId });
          await callRpc(supabaseUrl, supabaseKey, 'admin_update_last_polled', { p_integration_id: integrationId });
          continue;
        }

        drive = buildDriveClientOAuth(credentials.oauth_refresh_token, clientId, clientSecret);
        log('debug', 'integration.auth_method', { integration_id: integrationId, method: 'oauth' });

      } else if (credentials?.service_account_json) {
        // ── Service Account (TASK-39, retrocompatibilidad) ───────────────
        const serviceAccountJson = typeof credentials.service_account_json === 'string'
          ? JSON.parse(credentials.service_account_json)
          : credentials.service_account_json;

        drive = buildDriveClientServiceAccount(serviceAccountJson);
        log('debug', 'integration.auth_method', { integration_id: integrationId, method: 'service_account' });

      } else {
        log('warn', 'integration.missing_credentials', { integration_id: integrationId });
        await callRpc(supabaseUrl, supabaseKey, 'admin_update_last_polled', { p_integration_id: integrationId });
        continue;
      }

      // 3. Listar todos los archivos de la carpeta (sin filtro de fecha)
      const files = await listAllFiles(drive, folderId);

      log('info', 'integration.files_found', {
        integration_id: integrationId,
        count: files.length,
      });

      let enqueued = 0, skipped = 0, failed = 0;

      for (const file of files) {
        try {
          // 4. Verificar si ya fue procesado por drive_file_id
          const alreadyProcessed = await isDriveFileProcessed(supabaseUrl, supabaseKey, integrationId, file.id);
          if (alreadyProcessed) {
            log('debug', 'integration.file_skipped_duplicate', {
              integration_id: integrationId,
              filename:  file.name,
              drive_file_id: file.id,
            });
            skipped++;
            continue;
          }

          // 5. Descargar archivo
          const buffer = await downloadFile(drive, file.id);

          // 6. Subir a Supabase Storage
          const uniqueName = `${Date.now()}_${sanitizeStorageKey(file.name)}`;
          const fileUrl    = await uploadToStorage(
            supabaseUrl, supabaseKey,
            orgId, uniqueName, buffer, file.mimeType
          );

          // 7. Encolar en Input Gateway
          const fileType = SUPPORTED_MIME_TYPES[file.mimeType].file_type;
          await enqueueJob(gatewayUrl, gatewayApiKey, orgId, fileUrl, fileType, file.name, integrationId);

          // 8. Registrar drive_file_id como procesado
          await registerDriveFileProcessed(supabaseUrl, supabaseKey, integrationId, orgId, file.id, file.name);

          log('info', 'integration.file_enqueued', {
            integration_id: integrationId,
            filename:      file.name,
            file_type:     fileType,
            drive_file_id: file.id,
          });
          enqueued++;

          // 9. Mover original a procesados/ (best-effort)
          await moveFileToProcesados(drive, file.id, folderId, file.name, integrationId, log);

        } catch (fileErr) {
          log('error', 'integration.file_error', {
            integration_id: integrationId,
            filename: file.name,
            error:    fileErr.message,
          });
          failed++;
        }
      }

      // 9. Actualizar last_polled_at
      await callRpc(supabaseUrl, supabaseKey, 'admin_update_last_polled', { p_integration_id: integrationId });

      log('info', 'integration.tenant_done', {
        integration_id:  integrationId,
        organization_id: orgId,
        enqueued,
        skipped,
        failed,
      });

    } catch (tenantErr) {
      log('error', 'integration.tenant_error', {
        integration_id:  integrationId,
        organization_id: orgId,
        error: tenantErr.message,
      });
      try {
        await callRpc(supabaseUrl, supabaseKey, 'admin_update_last_polled', { p_integration_id: integrationId });
      } catch (_) {}
    }
  }

  log('info', 'integration.poll_done', { type: 'google_drive' });
}
