/**
 * integration-file-mover.mjs — Mueve archivos a procesados/ o fallidos/ post-worker
 * Data Laundering V2.0
 *
 * Se llama desde worker.mjs DESPUÉS de que el job termina (éxito o falla).
 * Usa el metadata del job (integration_id, protocol, fileMeta) para mover
 * el archivo original desde en_proceso/ al destino correcto en el storage
 * del cliente.
 *
 * Siempre best-effort: si falla el movimiento, loguea warn pero no relanza.
 * El archivo queda en en_proceso/ — detectable visualmente por el tenant.
 *
 * Protocolos soportados:
 *   supabase_storage  — REST API de Supabase Storage del cliente
 *   firebase_storage  — Firebase Admin SDK
 *   integration_drive — Google Drive API v3 (OAuth2)
 */

import { google } from 'googleapis';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_KEY         = process.env.SUPABASE_SERVICE_KEY;
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// ─── DB helper ────────────────────────────────────────────────────────────────

async function fetchIntegration(integrationId) {
  // credentials no es columna top-level — está en credentials_encrypted (bytea).
  // Seleccionamos integration_type, folder_path y organization_id; las credenciales
  // se obtienen vía RPC admin_get_integration_credentials que las desencripta.
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/tenant_integrations?id=eq.${encodeURIComponent(integrationId)}&select=integration_type,folder_path,organization_id&limit=1`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } },
  );
  if (!res.ok) return null;
  const data = await res.json();
  const row = data?.[0];
  if (!row) return null;

  // Obtener credenciales desencriptadas
  try {
    const credRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_get_integration_credentials`, {
      method:  'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ p_integration_id: integrationId, p_org_id: row.organization_id }),
    });
    if (credRes.ok) {
      row.credentials = await credRes.json();
    }
  } catch (_) { /* best-effort — si falla, credentials queda undefined */ }

  return row;
}

// ─── Supabase Storage mover ───────────────────────────────────────────────────

async function moveSupabaseFile(integration, fileMeta, targetFolder, log) {
  const { project_url: projectUrl, service_role_key: serviceRoleKey } = integration.credentials ?? {};
  const { original_path: sourcePath, bucket_name: bucketName } = fileMeta;

  if (!projectUrl || !serviceRoleKey || !bucketName || !sourcePath) {
    throw new Error('Supabase move: datos insuficientes (project_url, service_role_key, bucket_name, original_path)');
  }

  const filename = sourcePath.split('/').pop();
  // original_path = "{prefix}en_proceso/{filename}" → destino = "{prefix}{targetFolder}/{filename}"
  const destPath = sourcePath.replace(/en_proceso\/([^/]+)$/, `${targetFolder}/$1`);

  const res = await fetch(`${projectUrl}/storage/v1/object/move`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${serviceRoleKey}`,
      'apikey':        serviceRoleKey,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      bucketId:          bucketName,
      sourceKey:         sourcePath,
      destinationBucket: bucketName,
      destinationKey:    destPath,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase move failed (${res.status}): ${txt}`);
  }

  log('info', 'file_mover.moved', { protocol: 'supabase_storage', filename, from: 'en_proceso', to: targetFolder });
}

// ─── Firebase Storage mover ───────────────────────────────────────────────────

async function moveFirebaseFile(integration, fileMeta, targetFolder, log) {
  const { service_account_json, bucket_name: bucketName } = integration.credentials ?? {};
  const { original_path: sourcePath } = fileMeta;

  if (!service_account_json || !bucketName || !sourcePath) {
    throw new Error('Firebase move: datos insuficientes (service_account_json, bucket_name, original_path)');
  }

  const serviceAccount = typeof service_account_json === 'string'
    ? JSON.parse(service_account_json)
    : service_account_json;

  const filename = sourcePath.split('/').pop();
  const destPath = sourcePath.replace(/en_proceso\/([^/]+)$/, `${targetFolder}/$1`);

  const { initializeApp, deleteApp, cert } = await import('firebase-admin/app');
  const { getStorage } = await import('firebase-admin/storage');
  const app = initializeApp(
    { credential: cert(serviceAccount), storageBucket: bucketName },
    `dl_mover_${Date.now()}`,
  );

  try {
    const bucket = getStorage(app).bucket();
    await bucket.file(sourcePath).copy(bucket.file(destPath));
    await bucket.file(sourcePath).delete();
    log('info', 'file_mover.moved', { protocol: 'firebase_storage', filename, from: 'en_proceso', to: targetFolder });
  } finally {
    await deleteApp(app);
  }
}

// ─── Google Drive mover ───────────────────────────────────────────────────────

async function moveDriveFile(integration, fileMeta, targetFolder, log) {
  const { oauth_refresh_token: refreshToken } = integration.credentials ?? {};
  const { drive_file_id: fileId, en_proceso_folder_id: enProcesoId, client_folder_id: clientFolderId } = fileMeta;

  if (!refreshToken || !fileId || !enProcesoId || !clientFolderId) {
    throw new Error('Drive move: datos insuficientes (oauth_refresh_token, drive_file_id, en_proceso_folder_id, client_folder_id)');
  }

  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: refreshToken });
  const drive = google.drive({ version: 'v3', auth });

  // Buscar o crear carpeta destino dentro del mismo client_folder
  const searchRes = await drive.files.list({
    q: `name='${targetFolder}' and '${clientFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
  });

  let targetFolderId;
  if (searchRes.data.files?.length > 0) {
    targetFolderId = searchRes.data.files[0].id;
  } else {
    const created = await drive.files.create({
      requestBody: { name: targetFolder, mimeType: 'application/vnd.google-apps.folder', parents: [clientFolderId] },
      fields: 'id',
    });
    targetFolderId = created.data.id;
  }

  await drive.files.update({
    fileId,
    addParents:    targetFolderId,
    removeParents: enProcesoId,
    fields:        'id, parents',
  });

  log('info', 'file_mover.moved', { protocol: 'integration_drive', drive_file_id: fileId, from: 'en_proceso', to: targetFolder });
}

// ─── Export principal ─────────────────────────────────────────────────────────

/**
 * Mueve el archivo original del job desde en_proceso/ a procesados/ o fallidos/.
 * Se llama desde worker.mjs después de finalizeJob (success=true) o failJob (success=false).
 * Best-effort: nunca lanza — loguea warn si algo falla.
 */
export async function moveIntegrationFile({ integrationId, protocol, fileMeta, success, log }) {
  // Jobs sin integración (frontend_upload, api_direct) no tienen archivos que mover
  if (!integrationId || !protocol || !fileMeta) return;

  const targetFolder = success ? 'procesados' : 'fallidos';

  let integration;
  try {
    integration = await fetchIntegration(integrationId);
  } catch (err) {
    log('warn', 'file_mover.fetch_failed', { integration_id: integrationId, error: err.message });
    return;
  }

  if (!integration) {
    log('warn', 'file_mover.not_found', { integration_id: integrationId });
    return;
  }

  try {
    if (protocol === 'supabase_storage') {
      await moveSupabaseFile(integration, fileMeta, targetFolder, log);
    } else if (protocol === 'firebase_storage') {
      await moveFirebaseFile(integration, fileMeta, targetFolder, log);
    } else if (protocol === 'integration_drive' || protocol === 'google_drive') {
      await moveDriveFile(integration, fileMeta, targetFolder, log);
    }
    // Otros protocolos (ftp, sftp): no tienen en_proceso — se omiten silenciosamente
  } catch (err) {
    log('warn', 'file_mover.move_failed', {
      integration_id: integrationId, protocol, target: targetFolder, error: err.message,
    });
  }
}
