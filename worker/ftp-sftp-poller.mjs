/**
 * ftp-sftp-poller.mjs — Poller de integraciones FTP/SFTP
 * Data Laundering V2.0 — TASK-40
 *
 * Flujo por integración activa:
 *   1. Obtiene integraciones "due" via admin_get_active_integrations()
 *   2. Para ftp:  conecta con basic-ftp
 *   3. Para sftp: conecta con ssh2-sftp-client
 *   4. Lista archivos nuevos en la carpeta configurada
 *   5. Descarga → SHA256 → dedup → Supabase Storage → Input Gateway
 *   6. Actualiza last_polled_at
 */

import crypto    from 'node:crypto';
import path      from 'node:path';
import { Writable } from 'node:stream';

const SUPPORTED_EXTENSIONS = {
  '.pdf':  { file_type: 'pdf',  mime: 'application/pdf' },
  '.jpg':  { file_type: 'jpg',  mime: 'image/jpeg' },
  '.jpeg': { file_type: 'jpg',  mime: 'image/jpeg' },
  '.png':  { file_type: 'png',  mime: 'image/png' },
  '.zip':  { file_type: 'zip',  mime: 'application/zip' },
  '.rar':  { file_type: 'rar',  mime: 'application/x-rar-compressed' },
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

async function enqueueJob(gatewayUrl, gatewayApiKey, orgId, fileUrl, fileType, filename, integrationId, protocol) {
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
      metadata: {
        source:         'integration_remote',
        integration_id: integrationId,
        protocol,
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gateway enqueue failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ─── FTP (basic-ftp) ─────────────────────────────────────────────────────────

async function pollFtp(integration, { supabaseUrl, supabaseKey, gatewayUrl, gatewayApiKey, log }) {
  const { id: integrationId, organization_id: orgId, credentials, folder_path, last_polled_at } = integration;
  const { ftp: ftpLib } = await import('basic-ftp');
  const client = new ftpLib.Client();
  client.ftp.verbose = false;

  try {
    await client.access({
      host:     credentials.host,
      port:     Number(credentials.port ?? 21),
      user:     credentials.username,
      password: credentials.password,
      secure:   false,
    });

    const remotePath = folder_path || '/';
    const fileList   = await client.list(remotePath);
    const sinceDate  = last_polled_at ? new Date(last_polled_at) : null;

    // Filtrar: solo archivos con extensión soportada; mtime si el servidor lo provee
    const candidates = fileList.filter(f => {
      if (f.type !== 1) return false; // 1 = file
      const ext = path.extname(f.name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS[ext]) return false;
      if (sinceDate && f.modifiedAt instanceof Date && f.modifiedAt < sinceDate) return false;
      return true;
    });

    log('info', 'integration.files_found', {
      integration_id: integrationId,
      protocol: 'ftp',
      count: candidates.length,
      since: sinceDate?.toISOString() ?? 'all',
    });

    let enqueued = 0, skipped = 0, failed = 0;

    for (const file of candidates) {
      try {
        // Descargar a Buffer usando Writable
        const chunks   = [];
        const writable = new Writable({
          write(chunk, _enc, cb) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            cb();
          },
        });
        await client.downloadTo(writable, path.posix.join(remotePath, file.name));
        const buffer = Buffer.concat(chunks);

        // SHA256 + deduplicación
        const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
        const isNew = await callRpc(supabaseUrl, supabaseKey, 'admin_register_processed_file', {
          p_integration_id:  integrationId,
          p_organization_id: orgId,
          p_file_hash:       fileHash,
          p_filename:        file.name,
        });

        if (!isNew) {
          log('debug', 'integration.file_skipped_duplicate', { integration_id: integrationId, filename: file.name });
          skipped++;
          continue;
        }

        // Subir a Supabase Storage
        const ext        = path.extname(file.name).toLowerCase();
        const { file_type, mime } = SUPPORTED_EXTENSIONS[ext];
        const uniqueName = `${Date.now()}_${file.name}`;
        const fileUrl    = await uploadToStorage(supabaseUrl, supabaseKey, orgId, uniqueName, buffer, mime);

        // Encolar en Input Gateway
        await enqueueJob(gatewayUrl, gatewayApiKey, orgId, fileUrl, file_type, file.name, integrationId, 'ftp');

        log('info', 'integration.file_enqueued', {
          integration_id: integrationId,
          filename: file.name,
          file_type,
          protocol: 'ftp',
        });
        enqueued++;

      } catch (fileErr) {
        log('error', 'integration.file_error', {
          integration_id: integrationId,
          filename: file.name,
          protocol: 'ftp',
          error: fileErr.message,
        });
        failed++;
      }
    }

    log('info', 'integration.tenant_done', {
      integration_id: integrationId,
      organization_id: orgId,
      protocol: 'ftp',
      enqueued,
      skipped,
      failed,
    });

  } finally {
    client.close();
  }
}

// ─── SFTP (ssh2-sftp-client) ─────────────────────────────────────────────────

async function pollSftp(integration, { supabaseUrl, supabaseKey, gatewayUrl, gatewayApiKey, log }) {
  const { id: integrationId, organization_id: orgId, credentials, folder_path, last_polled_at } = integration;
  const { default: SftpClient } = await import('ssh2-sftp-client');
  const sftp = new SftpClient();

  try {
    const connectConfig = {
      host:     credentials.host,
      port:     Number(credentials.port ?? 22),
      username: credentials.username,
    };

    // Autenticación: clave privada o contraseña
    if (credentials.private_key) {
      connectConfig.privateKey = credentials.private_key;
    } else {
      connectConfig.password = credentials.password;
    }

    await sftp.connect(connectConfig);

    const remotePath = folder_path || '/';
    const fileList   = await sftp.list(remotePath);
    const sinceDate  = last_polled_at ? new Date(last_polled_at) : null;

    // Filtrar: solo archivos regulares con extensión soportada
    // modifyTime de ssh2-sftp-client es epoch en milisegundos
    const candidates = fileList.filter(f => {
      if (f.type !== '-') return false;
      const ext = path.extname(f.name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS[ext]) return false;
      if (sinceDate && f.modifyTime && new Date(f.modifyTime) < sinceDate) return false;
      return true;
    });

    log('info', 'integration.files_found', {
      integration_id: integrationId,
      protocol: 'sftp',
      count: candidates.length,
      since: sinceDate?.toISOString() ?? 'all',
    });

    let enqueued = 0, skipped = 0, failed = 0;

    for (const file of candidates) {
      try {
        // get() sin segundo argumento retorna Buffer directamente
        const buffer = await sftp.get(path.posix.join(remotePath, file.name));
        const buf    = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

        // SHA256 + deduplicación
        const fileHash = crypto.createHash('sha256').update(buf).digest('hex');
        const isNew = await callRpc(supabaseUrl, supabaseKey, 'admin_register_processed_file', {
          p_integration_id:  integrationId,
          p_organization_id: orgId,
          p_file_hash:       fileHash,
          p_filename:        file.name,
        });

        if (!isNew) {
          log('debug', 'integration.file_skipped_duplicate', { integration_id: integrationId, filename: file.name });
          skipped++;
          continue;
        }

        // Subir a Supabase Storage
        const ext        = path.extname(file.name).toLowerCase();
        const { file_type, mime } = SUPPORTED_EXTENSIONS[ext];
        const uniqueName = `${Date.now()}_${file.name}`;
        const fileUrl    = await uploadToStorage(supabaseUrl, supabaseKey, orgId, uniqueName, buf, mime);

        // Encolar en Input Gateway
        await enqueueJob(gatewayUrl, gatewayApiKey, orgId, fileUrl, file_type, file.name, integrationId, 'sftp');

        log('info', 'integration.file_enqueued', {
          integration_id: integrationId,
          filename: file.name,
          file_type,
          protocol: 'sftp',
        });
        enqueued++;

      } catch (fileErr) {
        log('error', 'integration.file_error', {
          integration_id: integrationId,
          filename: file.name,
          protocol: 'sftp',
          error: fileErr.message,
        });
        failed++;
      }
    }

    log('info', 'integration.tenant_done', {
      integration_id: integrationId,
      organization_id: orgId,
      protocol: 'sftp',
      enqueued,
      skipped,
      failed,
    });

  } finally {
    await sftp.end();
  }
}

// ─── Orquestador por tipo ────────────────────────────────────────────────────

async function pollByType(type, { supabaseUrl, supabaseKey, gatewayUrl, gatewayApiKey, log }) {
  let integrations;
  try {
    integrations = await callRpc(supabaseUrl, supabaseKey, 'admin_get_active_integrations', {
      p_type: type,
    });
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
    try {
      if (type === 'ftp') {
        await pollFtp(integration, { supabaseUrl, supabaseKey, gatewayUrl, gatewayApiKey, log });
      } else {
        await pollSftp(integration, { supabaseUrl, supabaseKey, gatewayUrl, gatewayApiKey, log });
      }
      // Actualizar last_polled_at tras procesar el tenant
      await callRpc(supabaseUrl, supabaseKey, 'admin_update_last_polled', {
        p_integration_id: integrationId,
      });
    } catch (tenantErr) {
      log('error', 'integration.tenant_error', {
        integration_id: integrationId,
        organization_id: orgId,
        protocol: type,
        error: tenantErr.message,
      });
      // Actualizar last_polled_at igual para no quedar en loop infinito
      try {
        await callRpc(supabaseUrl, supabaseKey, 'admin_update_last_polled', {
          p_integration_id: integrationId,
        });
      } catch (_) {}
    }
  }

  log('info', 'integration.poll_done', { type });
}

// ─── Export principal ────────────────────────────────────────────────────────

export async function pollFtpSftpIntegrations({ supabaseUrl, supabaseKey, gatewayUrl, gatewayApiKey, log }) {
  await pollByType('ftp',  { supabaseUrl, supabaseKey, gatewayUrl, gatewayApiKey, log });
  await pollByType('sftp', { supabaseUrl, supabaseKey, gatewayUrl, gatewayApiKey, log });
}
