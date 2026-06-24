/**
 * firebase-storage-poller.mjs — Poller de integraciones Firebase Storage
 * Data Laundering V2.0 — TASK-106
 *
 * Adaptador delgado: solo sabe cómo listar, descargar y mover en Firebase.
 * La lógica de dedup, upload a Aurora y enqueue vive en poller-handoff.mjs.
 *
 * Estructura de carpetas en bucket del cliente (Firebase Storage):
 *   raíz/                → usuario suelta archivos acá
 *   {prefix}en_proceso/  → poller mueve acá al levantar
 *   {prefix}procesados/  → worker mueve acá si procesó OK (integration-file-mover.mjs)
 *   {prefix}fallidos/    → worker mueve acá si falló   (integration-file-mover.mjs)
 *   {prefix}extracciones/→ worker deposita CSV resultante (output-depositor.mjs)
 *
 * Credenciales en tenant_integrations.credentials:
 *   { service_account_json, bucket_name }
 *
 * folder_path viene de integration.folder_path (columna top-level), NO de credentials.
 */

import path from 'node:path';
import {
  SUPPORTED_EXTENSIONS,
  checkAndRegisterFile,
  uploadAndEnqueue,
  registerRejectedFile,
  runIntegrationPoller,
} from './poller-handoff.mjs';

// Carpetas de sistema — nunca se procesan como archivos entrantes
const SYSTEM_FOLDERS = new Set(['en_proceso', 'procesados', 'fallidos', 'extracciones']);

// ─── Poller específico ────────────────────────────────────────────────────────

async function pollFirebaseStorage(integration, ctx) {
  const { id: integrationId, organization_id: orgId, credentials, folder_path: folderPath,
          polling_interval_minutes: pollingIntervalMinutes } = integration;
  const { log } = ctx;

  const { service_account_json, bucket_name: bucketName } = credentials ?? {};
  if (!service_account_json || !bucketName) {
    throw new Error('Firebase Storage: service_account_json y bucket_name son requeridos');
  }

  const serviceAccount = typeof service_account_json === 'string'
    ? JSON.parse(service_account_json)
    : service_account_json;

  // Prefix normalizado
  const rawFolder = (folderPath ?? '').trim().replace(/^\/+/, '');
  const prefix    = rawFolder ? (rawFolder.endsWith('/') ? rawFolder : `${rawFolder}/`) : '';

  // Importar Firebase Admin dinámicamente para evitar conflictos entre instancias
  const { initializeApp, deleteApp, cert } = await import('firebase-admin/app');
  const { getStorage } = await import('firebase-admin/storage');

  const appName = `dl_firebase_poller_${integrationId}_${Date.now()}`;
  const app = initializeApp(
    { credential: cert(serviceAccount), storageBucket: bucketName },
    appName,
  );

  try {
    const bucket = getStorage(app).bucket();

    // Listar archivos en raíz del prefix (no recursivo hacia carpetas de sistema)
    const [allFiles] = await bucket.getFiles({ prefix: prefix || undefined });

    // Filtrar archivos en el nivel raíz del prefix — excluir subcarpetas de sistema
    const candidates = allFiles.filter(file => {
      const relPath = prefix ? file.name.slice(prefix.length) : file.name;
      if (!relPath || relPath.endsWith('/')) return false;         // es carpeta
      const topSegment = relPath.split('/')[0];
      if (SYSTEM_FOLDERS.has(topSegment)) return false;            // carpeta de sistema
      if (relPath.includes('/')) return false;                     // subcarpeta no-sistema
      return !!SUPPORTED_EXTENSIONS[path.extname(file.name).toLowerCase()];
    });

    log('info', 'integration.files_found', {
      integration_id: integrationId, protocol: 'firebase_storage', count: candidates.length,
    });

    let enqueued = 0, skipped = 0, failed = 0, rejected = 0;

    for (const file of candidates) {
      const filename      = path.basename(file.name);
      const enProcesoPath = `${prefix}en_proceso/${filename}`;

      try {
        // 1. Descargar buffer desde raíz
        const [bufferArr] = await file.download();
        const buffer = Buffer.from(bufferArr);

        // 2. Dedup check
        const { isNew } = await checkAndRegisterFile({ buffer, filename, orgId, integrationId, ctx });

        if (!isNew) {
          // Ya fue procesado — mover directo a procesados/ para limpiar raíz
          try {
            await file.copy(bucket.file(`${prefix}procesados/${filename}`));
            await file.delete();
            log('info', 'integration.file_moved', {
              protocol: 'firebase_storage', from: file.name, to: `${prefix}procesados/${filename}`, context: 'already_processed',
            });
          } catch (moveErr) {
            log('warn', 'integration.file_move_failed', {
              protocol: 'firebase_storage', filename, error: moveErr.message, context: 'already_processed',
            });
          }
          skipped++;
          continue;
        }

        // 3. Nuevo: mover a en_proceso/ ANTES de encolar (no encolar si falla el move)
        try {
          await file.copy(bucket.file(enProcesoPath));
          await file.delete();
          log('info', 'integration.file_moved', {
            protocol: 'firebase_storage', from: file.name, to: enProcesoPath, context: 'to_en_proceso',
          });
        } catch (moveErr) {
          log('error', 'integration.file_move_failed', {
            protocol: 'firebase_storage', filename, error: moveErr.message, context: 'to_en_proceso',
          });
          failed++;
          continue;
        }

        // 4. Upload a Aurora + enqueue — fileMeta permite que el worker mueva después
        await uploadAndEnqueue({
          buffer, filename, orgId, integrationId, protocol: 'firebase_storage',
          pollingIntervalMinutes,
          fileMeta: { original_path: enProcesoPath, bucket_name: bucketName },
          ctx,
        });
        enqueued++;

      } catch (fileErr) {
        log('error', 'integration.file_error', {
          integration_id: integrationId, filename, protocol: 'firebase_storage', error: fileErr.message,
        });
        failed++;
      }
    }

    // TASK-110: archivos de formato no soportado → job fallido visible + mover a fallidos/
    const rejectedFiles = allFiles.filter(file => {
      const relPath = prefix ? file.name.slice(prefix.length) : file.name;
      if (!relPath || relPath.endsWith('/')) return false;
      const topSegment = relPath.split('/')[0];
      if (SYSTEM_FOLDERS.has(topSegment)) return false;
      if (relPath.includes('/')) return false;
      return !SUPPORTED_EXTENSIONS[path.extname(file.name).toLowerCase()];
    });
    for (const file of rejectedFiles) {
      const filename = path.basename(file.name);
      const ext      = path.extname(file.name).toLowerCase() || '(sin extensión)';
      await registerRejectedFile({ orgId, integrationId, protocol: 'firebase_storage', filename, reason: `Formato de archivo no permitido: ${ext} (${filename})`, ctx });
      try {
        await file.copy(bucket.file(`${prefix}fallidos/${filename}`));
        await file.delete();
        log('info', 'integration.file_moved', { protocol: 'firebase_storage', from: file.name, to: `${prefix}fallidos/${filename}`, context: 'to_fallidos_rejected' });
      } catch (moveErr) {
        log('warn', 'integration.file_move_failed', { protocol: 'firebase_storage', filename, error: moveErr.message, context: 'to_fallidos_rejected' });
      }
      rejected++;
    }

    log('info', 'integration.tenant_done', {
      integration_id: integrationId, organization_id: orgId, protocol: 'firebase_storage', enqueued, skipped, failed, rejected,
    });

  } finally {
    await deleteApp(app);
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export async function pollFirebaseStorageIntegrations(ctx) {
  await runIntegrationPoller({ type: 'firebase_storage', pollFn: pollFirebaseStorage, ctx });
}
