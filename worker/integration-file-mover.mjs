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
import { buildDocFileBase } from './doc-naming.mjs';

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

async function moveSupabaseFile(integration, fileMeta, targetFolder, log, renameBase) {
  const { project_url: projectUrl, service_role_key: serviceRoleKey } = integration.credentials ?? {};
  const { original_path: sourcePath, bucket_name: bucketName } = fileMeta;

  if (!projectUrl || !serviceRoleKey || !bucketName || !sourcePath) {
    throw new Error('Supabase move: datos insuficientes (project_url, service_role_key, bucket_name, original_path)');
  }

  const filename = sourcePath.split('/').pop();
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '';
  // FILE-RENAME-BY-DATA (Fase 1): renombrar solo al ir a procesados/ y con base provista
  // (storage, 1 doc, 3 datos). original_path = "{prefix}en_proceso/{filename}".
  const wantRename = !!renameBase && targetFolder === 'procesados';
  let destName = wantRename ? `${renameBase}${ext}` : filename;
  const buildDest = (name) => sourcePath.replace(/en_proceso\/[^/]+$/, `${targetFolder}/${name}`);

  const doMove = (name) => fetch(`${projectUrl}/storage/v1/object/move`, {
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
      destinationKey:    buildDest(name),
    }),
  });

  let duplicate = false;
  let res = await doMove(destName);
  if (!res.ok) {
    const txt = await res.text();
    // Duplicado: el destino {cuit}_{numero}_{afip} ya existe → NO piso el original; muevo el
    // archivo con marca visible DUPLICADO (sale de en_proceso) y dejo alerta en el log.
    if (wantRename && /exist|duplicate/i.test(txt)) {
      duplicate = true;
      destName = `${renameBase}__DUPLICADO_${Date.now()}${ext}`;
      log('warn', 'file_mover.duplicate', { protocol: 'supabase_storage', base: renameBase, kept_as: destName });
      res = await doMove(destName);
      if (!res.ok) {
        const t2 = await res.text();
        throw new Error(`Supabase move (dup) failed (${res.status}): ${t2}`);
      }
    } else {
      throw new Error(`Supabase move failed (${res.status}): ${txt}`);
    }
  }

  log('info', 'file_mover.moved', { protocol: 'supabase_storage', filename: destName, from: 'en_proceso', to: targetFolder });
  return { duplicate, processedPath: buildDest(destName) };
}

// ─── Firebase Storage mover ───────────────────────────────────────────────────

async function moveFirebaseFile(integration, fileMeta, targetFolder, log, renameBase) {
  const { service_account_json, bucket_name: bucketName } = integration.credentials ?? {};
  const { original_path: sourcePath } = fileMeta;

  if (!service_account_json || !bucketName || !sourcePath) {
    throw new Error('Firebase move: datos insuficientes (service_account_json, bucket_name, original_path)');
  }

  const serviceAccount = typeof service_account_json === 'string'
    ? JSON.parse(service_account_json)
    : service_account_json;

  const filename = sourcePath.split('/').pop();
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '';
  const wantRename = !!renameBase && targetFolder === 'procesados';
  let destName = wantRename ? `${renameBase}${ext}` : filename;
  const buildDest = (name) => sourcePath.replace(/en_proceso\/[^/]+$/, `${targetFolder}/${name}`);
  let destPath = buildDest(destName);
  let duplicate = false;

  const { initializeApp, deleteApp, cert } = await import('firebase-admin/app');
  const { getStorage } = await import('firebase-admin/storage');
  const app = initializeApp(
    { credential: cert(serviceAccount), storageBucket: bucketName },
    `dl_mover_${Date.now()}`,
  );

  try {
    const bucket = getStorage(app).bucket();
    // Duplicado: si el destino por dato ya existe, NO lo piso → marca visible DUPLICADO + alerta en log.
    if (wantRename) {
      const [exists] = await bucket.file(destPath).exists();
      if (exists) {
        duplicate = true;
        destName = `${renameBase}__DUPLICADO_${Date.now()}${ext}`;
        destPath = buildDest(destName);
        log('warn', 'file_mover.duplicate', { protocol: 'firebase_storage', base: renameBase, kept_as: destName });
      }
    }
    await bucket.file(sourcePath).copy(bucket.file(destPath));
    await bucket.file(sourcePath).delete();
    log('info', 'file_mover.moved', { protocol: 'firebase_storage', filename: destName, from: 'en_proceso', to: targetFolder });
    return { duplicate, processedPath: destPath };
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

// ─── Marca de duplicado (FILE-RENAME-BY-DATA Fase 2) ──────────────────────────

// Persiste la ubicación del archivo de entrada en pdf_jobs.file_location (para renombrarlo al
// aprobar, FILE-RENAME-BY-DATA Fase 2). Best-effort; solo single-doc storage (jobId presente).
async function writeFileLocation(jobId, fileLocation, log) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/pdf_jobs?id=eq.${encodeURIComponent(jobId)}`,
      {
        method:  'PATCH',
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=minimal',
        },
        body: JSON.stringify({ file_location: fileLocation }),
      },
    );
    if (!res.ok) log('warn', 'file_mover.file_location_failed', { job_id: jobId, status: res.status });
  } catch (err) {
    log('warn', 'file_mover.file_location_error', { job_id: jobId, error: err.message });
  }
}

// Setea is_duplicate=true en la fila del job (single-doc: 1 fila). Best-effort.
async function markRowDuplicate(jobId, log) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/pdf_job_rows?job_id=eq.${encodeURIComponent(jobId)}`,
      {
        method:  'PATCH',
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=minimal',
        },
        body: JSON.stringify({ is_duplicate: true }),
      },
    );
    if (!res.ok) log('warn', 'file_mover.mark_duplicate_failed', { job_id: jobId, status: res.status });
    else        log('info', 'file_mover.marked_duplicate', { job_id: jobId });
    // Flag a nivel proceso para el ⚠️ del dashboard.
    await fetch(
      `${SUPABASE_URL}/rest/v1/pdf_jobs?id=eq.${encodeURIComponent(jobId)}`,
      {
        method:  'PATCH',
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=minimal',
        },
        body: JSON.stringify({ has_duplicate: true }),
      },
    ).catch(() => {});
  } catch (err) {
    log('warn', 'file_mover.mark_duplicate_error', { job_id: jobId, error: err.message });
  }
}

// ─── Export principal ─────────────────────────────────────────────────────────

/**
 * Mueve el archivo original del job desde en_proceso/ a procesados/ o fallidos/.
 * Se llama desde worker.mjs después de finalizeJob (success=true) o failJob (success=false).
 * Best-effort: nunca lanza — loguea warn si algo falla.
 */
export async function moveIntegrationFile({ integrationId, protocol, fileMeta, success, log, renameBase, jobId }) {
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
    let moveResult;
    if (protocol === 'supabase_storage') {
      moveResult = await moveSupabaseFile(integration, fileMeta, targetFolder, log, renameBase);
    } else if (protocol === 'firebase_storage') {
      moveResult = await moveFirebaseFile(integration, fileMeta, targetFolder, log, renameBase);
    } else if (protocol === 'integration_drive' || protocol === 'google_drive') {
      await moveDriveFile(integration, fileMeta, targetFolder, log);  // Drive: nombre como está
    }

    // Duplicado detectado al renombrar (single-doc storage): marcar la fila para el badge del front.
    if (moveResult?.duplicate && jobId) {
      await markRowDuplicate(jobId, log);
    }

    // Persistir ubicación del archivo (single-doc storage) para poder renombrarlo al aprobar (Fase 2).
    if (jobId && moveResult?.processedPath
        && (protocol === 'supabase_storage' || protocol === 'firebase_storage')) {
      await writeFileLocation(jobId, {
        integration_id: integrationId,
        protocol,
        bucket_name:    fileMeta?.bucket_name ?? null,
        processed_path: moveResult.processedPath,
      }, log);
    }
    // Otros protocolos (ftp, sftp): no tienen en_proceso — se omiten silenciosamente
  } catch (err) {
    log('warn', 'file_mover.move_failed', {
      integration_id: integrationId, protocol, target: targetFolder, error: err.message,
    });
  }
}


// ─── Rename del input al aprobar (FILE-RENAME-BY-DATA Fase 2, Opción A) ────────

/**
 * Renombra IN-PLACE el archivo de entrada en procesados/ cuando se aprueba un documento
 * que antes estaba incompleto. Usa pdf_jobs.file_location (lo dejó el move) + los 3 datos
 * ya completos de la fila. Solo single-doc storage (Supabase/Firebase); Drive no aplica.
 * Best-effort: nunca lanza (loguea warn). Se llama desde el gateway tras depositar la fila.
 */
export async function renameProcessedInputOnApproval({ jobId, log }) {
  if (!jobId || !SUPABASE_URL || !SUPABASE_KEY) return;
  const H = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };

  // 1. file_location del job
  let fileLoc;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/pdf_jobs?id=eq.${encodeURIComponent(jobId)}&select=file_location&limit=1`, { headers: H });
    if (!res.ok) return;
    const data = await res.json();
    fileLoc = data?.[0]?.file_location;
  } catch { return; }
  if (!fileLoc?.processed_path || !fileLoc?.integration_id) return;
  const protocol = fileLoc.protocol;
  if (protocol !== 'supabase_storage' && protocol !== 'firebase_storage') return; // Drive no se renombra

  // 2. fila única del job → base por dato
  let rows;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/pdf_job_rows?job_id=eq.${encodeURIComponent(jobId)}&select=cuit,numero_comprobante,codigo_afip,punto_venta`, { headers: H });
    if (!res.ok) return;
    rows = await res.json();
  } catch { return; }
  if (!Array.isArray(rows) || rows.length !== 1) return; // solo single-doc
  const newBase = buildDocFileBase(rows[0]);
  if (!newBase) return; // aún faltan datos → no renombra

  // 3. nombre nuevo (si ya está nombrado por dato, no hace nada)
  const curPath = fileLoc.processed_path;
  const curName = curPath.split('/').pop();
  const ext = curName.includes('.') ? curName.slice(curName.lastIndexOf('.')) : '';
  const newName = `${newBase}${ext}`;
  if (curName === newName) return;
  const destPath = curPath.replace(/[^/]+$/, newName);
  const dupPath  = () => curPath.replace(/[^/]+$/, `${newBase}__DUPLICADO_${Date.now()}${ext}`);

  // 4. credenciales
  let integration;
  try { integration = await fetchIntegration(fileLoc.integration_id); } catch { return; }
  if (!integration) { log('warn', 'file_mover.approval_rename_no_integration', { job_id: jobId }); return; }

  try {
    let finalDest = destPath;
    let duplicate = false;

    if (protocol === 'supabase_storage') {
      const { project_url: projectUrl, service_role_key: serviceRoleKey } = integration.credentials ?? {};
      const bucketName = fileLoc.bucket_name;
      if (!projectUrl || !serviceRoleKey || !bucketName) return;
      const doMove = (dest) => fetch(`${projectUrl}/storage/v1/object/move`, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${serviceRoleKey}`, 'apikey': serviceRoleKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucketId: bucketName, sourceKey: curPath, destinationBucket: bucketName, destinationKey: dest }),
      });
      let res = await doMove(finalDest);
      if (!res.ok) {
        const txt = await res.text();
        if (/exist|duplicate/i.test(txt)) {
          duplicate = true; finalDest = dupPath();
          log('warn', 'file_mover.duplicate', { protocol, base: newBase, kept_as: finalDest.split('/').pop(), via: 'approval' });
          res = await doMove(finalDest);
          if (!res.ok) { const t2 = await res.text(); throw new Error(`supabase approval-rename dup failed (${res.status}): ${t2}`); }
        } else { throw new Error(`supabase approval-rename failed (${res.status}): ${txt}`); }
      }
    } else { // firebase_storage
      const { service_account_json } = integration.credentials ?? {};
      const bucketName = fileLoc.bucket_name;
      if (!service_account_json || !bucketName) return;
      const serviceAccount = typeof service_account_json === 'string' ? JSON.parse(service_account_json) : service_account_json;
      const { initializeApp, deleteApp, cert } = await import('firebase-admin/app');
      const { getStorage } = await import('firebase-admin/storage');
      const app = initializeApp({ credential: cert(serviceAccount), storageBucket: bucketName }, `dl_rename_${Date.now()}`);
      try {
        const bucket = getStorage(app).bucket();
        const [exists] = await bucket.file(finalDest).exists();
        if (exists) {
          duplicate = true; finalDest = dupPath();
          log('warn', 'file_mover.duplicate', { protocol, base: newBase, kept_as: finalDest.split('/').pop(), via: 'approval' });
        }
        await bucket.file(curPath).copy(bucket.file(finalDest));
        await bucket.file(curPath).delete();
      } finally { await deleteApp(app); }
    }

    await writeFileLocation(jobId, { ...fileLoc, processed_path: finalDest }, log);
    if (duplicate) await markRowDuplicate(jobId, log);
    log('info', 'file_mover.approval_renamed', { job_id: jobId, protocol, to: finalDest.split('/').pop() });
  } catch (err) {
    log('warn', 'file_mover.approval_rename_failed', { job_id: jobId, protocol, error: err.message });
  }
}
