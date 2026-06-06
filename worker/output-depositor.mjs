/**
 * output-depositor.mjs — TASK-73: Output depositor Google Drive + formato XLSX
 * Data Laundering V2.0
 *
 * Cambios v2 (TASK-73):
 * - Google Drive: OAuth2 (refresh_token) en lugar de Service Account
 * - Soporte formato XLSX además de CSV
 * - Nombre de archivo incluye timestamp legible
 *
 * Best-effort: si falla, loguea warning pero el job NO falla.
 */

import path        from 'node:path';
import { google }  from 'googleapis';
import XLSX        from 'xlsx';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_KEY         = process.env.SUPABASE_SERVICE_KEY;
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// Columnas del CSV/XLSX en orden
const COLUMNS = [
  'fecha', 'tipo_documento', 'codigo_afip', 'punto_venta', 'numero_comprobante',
  'proveedor', 'cuit', 'receptor_nombre', 'receptor_cuit', 'cliente',
  'neto_gravado', 'iva', 'iva_21', 'iva_105', 'iva_27', 'iva_5', 'iva_25',
  'percepcion_iva', 'percepcion_ingresos_brutos', 'impuestos_internos',
  'monto_exento', 'total', 'moneda', 'orden_compra', 'nro_cae',
  'fecha_vto_cae', 'confidence_score', 'doc_status',
];

// ─── Generadores de archivo ───────────────────────────────────────────────────

function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function rowsToCSV(rows) {
  const header = COLUMNS.join(',');
  const lines = rows.map(row => COLUMNS.map(col => escapeCSV(row[col])).join(','));
  return [header, ...lines].join('\n');
}

function rowsToXLSX(rows) {
  const data = rows.map(row => {
    const obj = {};
    COLUMNS.forEach(col => { obj[col] = row[col] ?? ''; });
    return obj;
  });
  const ws = XLSX.utils.json_to_sheet(data, { header: COLUMNS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Facturas');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ─── Helpers Supabase ─────────────────────────────────────────────────────────

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

// ─── Google Drive OAuth2 ──────────────────────────────────────────────────────

/**
 * Crea un cliente Drive autenticado via OAuth2 (refresh_token).
 * Reutiliza la lógica del gateway — mismas credenciales de entorno.
 */
function createDriveClient(refreshToken) {
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: 'v3', auth });
}

/**
 * Busca o crea la subcarpeta de salida dentro del folder configurado.
 * Por defecto usa "procesados".
 */
async function ensureOutputFolder(drive, parentFolderId, folderName = 'procesados', log) {
  const searchRes = await drive.files.list({
    q: `name='${folderName}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive',
  });

  if (searchRes.data.files?.length > 0) {
    return searchRes.data.files[0].id;
  }

  // Crear si no existe
  const createRes = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    },
    fields: 'id',
  });
  log('info', 'output.drive_folder_created', { parent: parentFolderId, folder: folderName, id: createRes.data.id });
  return createRes.data.id;
}

// ─── Depositores por tipo ─────────────────────────────────────────────────────

async function depositToDrive(credentials, outputFolderName, filename, fileContent, mimeType, log) {
  const refreshToken = credentials.oauth_refresh_token;
  if (!refreshToken) throw new Error('Google Drive: oauth_refresh_token no configurado');

  const folderId = credentials.folder_id;
  if (!folderId) throw new Error('Google Drive: folder_id no configurado');

  const drive = createDriveClient(refreshToken);

  // Depositar en la subcarpeta configurada (default: procesados)
  const targetFolderId = await ensureOutputFolder(drive, folderId, outputFolderName || 'procesados', log);

  const { Readable } = await import('node:stream');
  const body = Buffer.isBuffer(fileContent)
    ? Readable.from(fileContent)
    : Readable.from([fileContent]);

  const uploadRes = await drive.files.create({
    requestBody: {
      name:    filename,
      parents: [targetFolderId],
      mimeType,
    },
    media: { mimeType, body },
    fields: 'id, name',
  });

  return uploadRes.data.id;
}

async function depositToSftp(credentials, baseFolderPath, outputFolderPath, filename, fileContent, log) {
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

    const targetDir = outputFolderPath
      ? path.posix.join(baseFolderPath || '/', outputFolderPath)
      : (baseFolderPath || '/');

    const dirExists = await sftp.exists(targetDir);
    if (!dirExists) {
      await sftp.mkdir(targetDir, true);
      log('info', 'output.sftp_dir_created', { dir: targetDir });
    }

    const remotePath = path.posix.join(targetDir, filename);
    const buf = Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent, 'utf-8');
    await sftp.put(buf, remotePath);
    return remotePath;
  } finally {
    await sftp.end();
  }
}

async function depositToFtp(credentials, baseFolderPath, outputFolderPath, filename, fileContent, log) {
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

    const buf = Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent, 'utf-8');
    const stream = Readable.from([buf]);
    await client.uploadFrom(stream, filename);

    return path.posix.join(targetDir, filename);
  } finally {
    client.close();
  }
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
    if (!res.ok) return;
    const data = await res.json();
    if (!data || data.length === 0) return;
    outputConfig = Array.isArray(data) ? data[0] : data;
  } catch (err) {
    log('warn', 'output.config_fetch_failed', { job_id: jobId, error: err.message });
    return;
  }

  const outputFormat = outputConfig.output_format ?? 'csv';

  log('info', 'output.deposit_start', {
    job_id:           jobId,
    organization_id:  orgId,
    integration_type: outputConfig.integration_type,
    format:           outputFormat,
  });

  // 2. Obtener filas del job
  let rows;
  try {
    const res = await supabaseFetch(
      `/rest/v1/pdf_job_rows?job_id=eq.${encodeURIComponent(jobId)}&select=${COLUMNS.join(',')}&order=id.asc`
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

  // 3. Generar archivo según formato
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  let fileContent, filename, mimeType;

  if (outputFormat === 'xlsx') {
    fileContent = rowsToXLSX(rows);
    filename    = `resultado_${jobId.slice(0, 8)}_${timestamp}.xlsx`;
    mimeType    = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  } else {
    fileContent = rowsToCSV(rows);
    filename    = `resultado_${jobId.slice(0, 8)}_${timestamp}.csv`;
    mimeType    = 'text/csv';
  }

  // 4. Depositar según tipo de integración
  try {
    if (outputConfig.integration_type === 'google_drive') {
      const fileId = await depositToDrive(
        outputConfig.credentials,
        outputConfig.output_folder_path || 'procesados',
        filename,
        fileContent,
        mimeType,
        log
      );
      log('info', 'output.deposited', {
        job_id: jobId, organization_id: orgId,
        integration_type: 'google_drive', filename, format: outputFormat,
        drive_file_id: fileId,
      });

    } else if (outputConfig.integration_type === 'sftp') {
      const remotePath = await depositToSftp(
        outputConfig.credentials,
        outputConfig.folder_path ?? '/',
        outputConfig.output_folder_path,
        filename, fileContent, log
      );
      log('info', 'output.deposited', {
        job_id: jobId, organization_id: orgId,
        integration_type: 'sftp', filename, format: outputFormat,
        remote_path: remotePath,
      });

    } else if (outputConfig.integration_type === 'ftp') {
      const remotePath = await depositToFtp(
        outputConfig.credentials,
        outputConfig.folder_path ?? '/',
        outputConfig.output_folder_path,
        filename, fileContent, log
      );
      log('info', 'output.deposited', {
        job_id: jobId, organization_id: orgId,
        integration_type: 'ftp', filename, format: outputFormat,
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
    log('warn', 'output.deposit_failed', {
      job_id: jobId, organization_id: orgId,
      integration_type: outputConfig.integration_type,
      format: outputFormat, error: err.message,
    });
  }
}
