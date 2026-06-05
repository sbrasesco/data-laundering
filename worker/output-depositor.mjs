/**
 * output-depositor.mjs — TASK-65: Depósito automático de CSV en integración de salida
 * Data Laundering V2.0
 *
 * Luego de finalizar un job, si el tenant tiene output_enabled = true en su integración,
 * genera el CSV con los resultados y lo deposita en la carpeta configurada.
 *
 * Best-effort: si falla, loguea warning pero el job NO falla.
 */

import path        from 'node:path';
import { google } from 'googleapis';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Columnas del CSV en orden
const CSV_COLUMNS = [
  'fecha', 'tipo_documento', 'codigo_afip', 'punto_venta', 'numero_comprobante',
  'proveedor', 'cuit', 'receptor_nombre', 'receptor_cuit', 'cliente',
  'neto_gravado', 'iva', 'iva_21', 'iva_105', 'iva_27', 'iva_5', 'iva_25',
  'percepcion_iva', 'percepcion_ingresos_brutos', 'impuestos_internos',
  'monto_exento', 'total', 'moneda', 'orden_compra', 'nro_cae',
  'fecha_vto_cae', 'confidence_score', 'doc_status',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function rowsToCSV(rows) {
  const header = CSV_COLUMNS.join(',');
  const lines = rows.map(row =>
    CSV_COLUMNS.map(col => escapeCSV(row[col])).join(',')
  );
  return [header, ...lines].join('\n');
}

async function supabaseFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      ...(options.headers ?? {}),
    },
  });
  return res;
}

// ─── SFTP output (ssh2-sftp-client) ──────────────────────────────────────────

async function depositToSftp(credentials, baseFolderPath, outputFolderPath, filename, csvContent, log) {
  const { default: SftpClient } = await import('ssh2-sftp-client');
  const sftp = new SftpClient();

  try {
    const connectConfig = {
      host:     credentials.host,
      port:     Number(credentials.port ?? 22),
      username: credentials.username,
    };
    if (credentials.private_key) {
      connectConfig.privateKey = credentials.private_key;
    } else {
      connectConfig.password = credentials.password;
    }

    await sftp.connect(connectConfig);

    // Resolver carpeta destino: outputFolderPath relativo a la carpeta base
    const targetDir = outputFolderPath
      ? path.posix.join(baseFolderPath || '/', outputFolderPath)
      : (baseFolderPath || '/');

    const dirExists = await sftp.exists(targetDir);
    if (!dirExists) {
      await sftp.mkdir(targetDir, true);
      log('info', 'output.sftp_dir_created', { dir: targetDir });
    }

    const remotePath = path.posix.join(targetDir, filename);
    await sftp.put(Buffer.from(csvContent, 'utf-8'), remotePath);
    return remotePath;
  } finally {
    await sftp.end();
  }
}

// ─── FTP output (basic-ftp) ───────────────────────────────────────────────────

async function depositToFtp(credentials, baseFolderPath, outputFolderPath, filename, csvContent, log) {
  const { ftp: ftpLib } = await import('basic-ftp');
  const { Readable }    = await import('node:stream');
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

    const targetDir = outputFolderPath
      ? path.posix.join(baseFolderPath || '/', outputFolderPath)
      : (baseFolderPath || '/');

    await client.ensureDir(targetDir);

    const stream = Readable.from([Buffer.from(csvContent, 'utf-8')]);
    await client.uploadFrom(stream, filename);

    return path.posix.join(targetDir, filename);
  } finally {
    client.close();
  }
}

// ─── Google Drive output ──────────────────────────────────────────────────────

async function depositToDrive(credentials, outputFolderPath, filename, csvContent, log) {
  const serviceAccountJson = typeof credentials.service_account_json === 'string'
    ? JSON.parse(credentials.service_account_json)
    : credentials.service_account_json;

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccountJson,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  const drive = google.drive({ version: 'v3', auth });

  // Resolver folder ID: puede ser un ID directo o un path relativo al folder_id de la integración
  const folderId = credentials.folder_id ?? 'root';

  // Crear subcarpeta de salida si no es la raíz
  let targetFolderId = folderId;
  if (outputFolderPath && outputFolderPath !== '.' && outputFolderPath !== '/') {
    // Buscar o crear la carpeta de salida
    const folderName = outputFolderPath.replace(/^\/+|\/+$/g, ''); // trim slashes
    const searchRes = await drive.files.list({
      q: `name='${folderName}' and '${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)',
    });
    if (searchRes.data.files?.length > 0) {
      targetFolderId = searchRes.data.files[0].id;
    } else {
      const createRes = await drive.files.create({
        requestBody: {
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [folderId],
        },
        fields: 'id',
      });
      targetFolderId = createRes.data.id;
      log('info', 'output.drive_folder_created', { folder: folderName, id: targetFolderId });
    }
  }

  // Subir el CSV
  const { Readable } = await import('node:stream');
  const stream = Readable.from([csvContent]);

  const uploadRes = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [targetFolderId],
      mimeType: 'text/csv',
    },
    media: {
      mimeType: 'text/csv',
      body: stream,
    },
    fields: 'id, name',
  });

  return uploadRes.data.id;
}

// ─── Función principal ────────────────────────────────────────────────────────

export async function depositOutputIfConfigured(jobId, orgId, log) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;

  // 1. Verificar si el org tiene output habilitado
  let outputConfig;
  try {
    const res = await supabaseFetch('/rest/v1/rpc/admin_get_output_integration', {
      method: 'POST',
      body: JSON.stringify({ p_organization_id: orgId }),
    });
    if (!res.ok) return; // Sin output configurado, silencioso
    const data = await res.json();
    if (!data || data.length === 0) return;
    outputConfig = Array.isArray(data) ? data[0] : data;
  } catch (err) {
    log('warn', 'output.config_fetch_failed', { job_id: jobId, error: err.message });
    return;
  }

  log('info', 'output.deposit_start', {
    job_id: jobId,
    organization_id: orgId,
    integration_type: outputConfig.integration_type,
    format: outputConfig.output_format,
  });

  // 2. Obtener filas del job
  let rows;
  try {
    const res = await supabaseFetch(
      `/rest/v1/pdf_job_rows?job_id=eq.${encodeURIComponent(jobId)}&select=${CSV_COLUMNS.join(',')}&order=id.asc`
    );
    if (!res.ok) throw new Error(`pdf_job_rows fetch failed: ${res.status}`);
    rows = await res.json();
  } catch (err) {
    log('warn', 'output.rows_fetch_failed', { job_id: jobId, error: err.message });
    return;
  }

  if (!rows || rows.length === 0) {
    log('info', 'output.no_rows', { job_id: jobId });
    return;
  }

  // 3. Generar CSV
  const csvContent = rowsToCSV(rows);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `resultado_${jobId.slice(0, 8)}_${timestamp}.csv`;

  // 4. Depositar según tipo de integración
  try {
    if (outputConfig.integration_type === 'google_drive') {
      const fileId = await depositToDrive(
        outputConfig.credentials,
        outputConfig.output_folder_path,
        filename,
        csvContent,
        log
      );
      log('info', 'output.deposited', {
        job_id: jobId,
        organization_id: orgId,
        integration_type: 'google_drive',
        filename,
        drive_file_id: fileId,
      });
    } else if (outputConfig.integration_type === 'sftp') {
      const remotePath = await depositToSftp(
        outputConfig.credentials,
        outputConfig.folder_path ?? '/',
        outputConfig.output_folder_path,
        filename,
        csvContent,
        log
      );
      log('info', 'output.deposited', {
        job_id: jobId,
        organization_id: orgId,
        integration_type: 'sftp',
        filename,
        remote_path: remotePath,
      });
    } else if (outputConfig.integration_type === 'ftp') {
      const remotePath = await depositToFtp(
        outputConfig.credentials,
        outputConfig.folder_path ?? '/',
        outputConfig.output_folder_path,
        filename,
        csvContent,
        log
      );
      log('info', 'output.deposited', {
        job_id: jobId,
        organization_id: orgId,
        integration_type: 'ftp',
        filename,
        remote_path: remotePath,
      });
    } else {
      log('info', 'output.integration_type_pending', {
        job_id: jobId,
        integration_type: outputConfig.integration_type,
        note: 'Tipo de integración sin soporte de salida aún',
      });
    }
  } catch (err) {
    // Best-effort: fallo en el depósito no falla el job
    log('warn', 'output.deposit_failed', {
      job_id: jobId,
      organization_id: orgId,
      integration_type: outputConfig.integration_type,
      error: err.message,
    });
  }
}
