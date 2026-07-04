/**
 * output-depositor.mjs — TASK-73 / TASK-78: Output depositor Google Drive + formato XLSX
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
import { buildDocFileBase } from './doc-naming.mjs';

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

// Salida (CSV y XLSX, mismo criterio): SIN la columna 'iva' genérica (es el total, confunde y
// descuadra la importación) y con encabezados legibles para las alícuotas.
const OUT_COLUMNS = COLUMNS.filter(c => c !== 'iva');
const OUT_LABELS = {
  iva_21:  'IVA 21%',
  iva_105: 'IVA 10,5%',
  iva_27:  'IVA 27%',
  iva_5:   'IVA 5%',
  iva_25:  'IVA 2,5%',
};
const outLabel = (col) => OUT_LABELS[col] ?? col;

function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(';') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function rowsToCSV(rows) {
  const header = OUT_COLUMNS.map(outLabel).join(';');
  const lines = rows.map(row => OUT_COLUMNS.map(col => escapeCSV(row[col])).join(';'));
  return [header, ...lines].join('\n');
}

function rowsToXLSX(rows) {
  const headers = OUT_COLUMNS.map(outLabel);
  const data = rows.map(row => {
    const obj = {};
    OUT_COLUMNS.forEach(col => { obj[outLabel(col)] = row[col] ?? ''; });
    return obj;
  });
  const ws = XLSX.utils.json_to_sheet(data, { header: headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Facturas');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ─── LINE-ITEMS Fase 4: archivo de PRODUCTOS (detalle de renglones), gateado por line_items_enabled ───
const PRODUCT_COLUMNS = ['cuit', 'numero_comprobante', 'descripcion', 'cantidad', 'precio_unitario', 'importe'];
const PRODUCT_LABELS  = { cuit: 'CUIT', numero_comprobante: 'Nro Comprobante', descripcion: 'Descripción', cantidad: 'Cantidad', precio_unitario: 'Precio Unitario', importe: 'Importe' };

function productsToCSV(prods) {
  const header = PRODUCT_COLUMNS.map(c => PRODUCT_LABELS[c]).join(';');
  const lines  = prods.map(p => PRODUCT_COLUMNS.map(c => escapeCSV(p[c])).join(';'));
  return [header, ...lines].join('\n');
}
function productsToXLSX(prods) {
  const headers = PRODUCT_COLUMNS.map(c => PRODUCT_LABELS[c]);
  const data = prods.map(p => { const o = {}; PRODUCT_COLUMNS.forEach(c => { o[PRODUCT_LABELS[c]] = p[c] ?? ''; }); return o; });
  const ws = XLSX.utils.json_to_sheet(data, { header: headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Productos');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ─── Helpers generales ───────────────────────────────────────────────────────

function sanitizeFolderName(name) {
  return name.replace(/[/\\:*?"<>|]/g, '_').trim();
}

// ─── Helpers Supabase ─────────────────────────────────────────────────────────

/**
 * Devuelve el nombre de carpeta Drive del cliente (`{name} — {tax_id}` sanitizado),
 * o null si no se puede resolver (cliente sin tax_id, error, etc.).
 */
async function fetchClientFolderName(orgId, clientId, log) {
  try {
    const res = await supabaseFetch(
      `/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}&organization_id=eq.${encodeURIComponent(orgId)}&select=name,tax_id&limit=1`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const client = data?.[0];
    if (!client?.name || !client?.tax_id) return null;
    return sanitizeFolderName(`${client.name} — ${client.tax_id}`);
  } catch (err) {
    log('warn', 'output.fetch_client_folder_name_failed', { client_id: clientId, error: err.message });
    return null;
  }
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

// FILE-RENAME-BY-DATA Fase 2: ¿esta fila es un duplicado de una factura ya procesada antes en la
// misma org? (mismo cuit + numero_comprobante, con id menor = anterior). Si lo es, NO se deposita
// salida (para no entregar un CSV repetido que el cliente levantaría de nuevo). Best-effort.
async function hasEarlierDuplicate(orgId, rowId, cuit, puntoVenta, numero, log) {
  if (!orgId || !rowId || !cuit || !numero) return false;
  try {
    const res = await supabaseFetch(
      `/rest/v1/pdf_job_rows?select=id,pdf_jobs!inner(organization_id)` +
      `&cuit=eq.${encodeURIComponent(cuit)}` +
      (puntoVenta ? `&punto_venta=eq.${encodeURIComponent(puntoVenta)}` : '') +
      `&numero_comprobante=eq.${encodeURIComponent(numero)}` +
      `&id=lt.${encodeURIComponent(rowId)}` +
      `&pdf_jobs.organization_id=eq.${encodeURIComponent(orgId)}&limit=1`
    );
    if (!res.ok) return false;
    const data = await res.json();
    return Array.isArray(data) && data.length > 0;
  } catch (err) {
    log('warn', 'output.dup_check_failed', { row_id: rowId, error: err.message });
    return false;
  }
}

async function markDuplicate(rowId, jobId, log) {
  try {
    const res = await supabaseFetch(`/rest/v1/pdf_job_rows?id=eq.${encodeURIComponent(rowId)}`, {
      method:  'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body:    JSON.stringify({ is_duplicate: true }),
    });
    if (!res.ok) log('warn', 'output.mark_dup_failed', { row_id: rowId, status: res.status });
    // Flag a nivel proceso para el ⚠️ del dashboard.
    if (jobId) {
      await supabaseFetch(`/rest/v1/pdf_jobs?id=eq.${encodeURIComponent(jobId)}`, {
        method:  'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body:    JSON.stringify({ has_duplicate: true }),
      });
    }
  } catch (err) {
    log('warn', 'output.mark_dup_error', { row_id: rowId, error: err.message });
  }
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
async function ensureOutputFolder(drive, parentFolderId, folderName = 'extracciones', log) {
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

/**
 * Busca "resultados.xlsx" en targetFolderId.
 * Si existe: descarga, agrega filas nuevas al final, re-sube (update).
 * Si no existe: crea el archivo desde cero con headers + filas.
 */
async function appendOrCreateXLSXInDrive(drive, targetFolderId, newRows, log) {
  const ACCUM_FILE = 'resultados.xlsx';
  const mimeType   = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  const searchRes = await drive.files.list({
    q:      `name='${ACCUM_FILE}' and '${targetFolderId}' in parents and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
  });
  const existing = searchRes.data.files?.[0];

  let existingRows = [];
  if (existing) {
    const dlRes = await drive.files.get(
      { fileId: existing.id, alt: 'media' },
      { responseType: 'arraybuffer' }
    );
    const wb = XLSX.read(Buffer.from(dlRes.data), { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    existingRows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  }

  // Re-mapea a los encabezados nuevos: dropea 'iva' y renombra alícuotas (iva_21->'IVA 21%', ...).
  // Migra archivos viejos en el próximo append. Idempotente: toma el label nuevo si existe, si no la key vieja.
  const remapRow = (r) => {
    const obj = {};
    OUT_COLUMNS.forEach(col => { const lbl = outLabel(col); obj[lbl] = r[lbl] ?? r[col] ?? ''; });
    return obj;
  };
  const allRows = [...existingRows.map(remapRow), ...newRows.map(remapRow)];

  const ws = XLSX.utils.json_to_sheet(allRows, { header: OUT_COLUMNS.map(outLabel) });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Facturas');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const { Readable } = await import('node:stream');

  if (existing) {
    await drive.files.update({
      fileId: existing.id,
      media:  { mimeType, body: Readable.from(buffer) },
    });
    log('info', 'output.drive_xlsx_appended', {
      file_id:    existing.id,
      new_rows:   newRows.length,
      total_rows: allRows.length,
    });
    return existing.id;
  } else {
    const createRes = await drive.files.create({
      requestBody: { name: ACCUM_FILE, parents: [targetFolderId], mimeType },
      media:       { mimeType, body: Readable.from(buffer) },
      fields:      'id',
    });
    log('info', 'output.drive_xlsx_created', { file_id: createRes.data.id, rows: allRows.length });
    return createRes.data.id;
  }
}

/**
 * Drive + xlsx acumulativo por cliente.
 * Resuelve la carpeta {cliente}/extracciones/ y delega en appendOrCreateXLSXInDrive.
 */
async function depositToDriveAccumulative(credentials, outputFolderName, rows, log, clientFolderName) {
  const refreshToken = credentials.oauth_refresh_token;
  if (!refreshToken) throw new Error('Google Drive: oauth_refresh_token no configurado');
  const folderId = credentials.folder_id;
  if (!folderId) throw new Error('Google Drive: folder_id no configurado');

  const drive = createDriveClient(refreshToken);

  let parentFolderId = folderId;
  if (clientFolderName) {
    parentFolderId = await ensureOutputFolder(drive, folderId, clientFolderName, log);
  }
  const targetFolderId = await ensureOutputFolder(drive, parentFolderId, outputFolderName || 'extracciones', log);

  return await appendOrCreateXLSXInDrive(drive, targetFolderId, rows, log);
}

// ¿El tenant tiene la feature de productos ON? (gatea la salida de productos)
async function lineItemsEnabledForOrg(orgId) {
  try {
    const res = await supabaseFetch(`/rest/v1/tenant_feature_flags?organization_id=eq.${encodeURIComponent(orgId)}&select=line_items_enabled`);
    if (!res.ok) return false;
    const d = await res.json();
    return d?.[0]?.line_items_enabled === true;
  } catch { return false; }
}

// Renglones de las facturas del job, con cuit+numero de referencia.
async function fetchProductsForRows(rows) {
  const ids = rows.map(r => r.id).filter(v => v != null);
  if (ids.length === 0) return [];
  try {
    const res = await supabaseFetch(`/rest/v1/pdf_job_row_items?row_id=in.(${ids.join(',')})&select=row_id,descripcion,cantidad,precio_unitario,importe,orden&order=row_id.asc,orden.asc`);
    if (!res.ok) return [];
    const items = await res.json();
    const byRow = new Map(rows.map(r => [r.id, r]));
    return items.map(it => {
      const r = byRow.get(it.row_id) ?? {};
      return { cuit: r.cuit ?? '', numero_comprobante: r.numero_comprobante ?? '', descripcion: it.descripcion ?? '', cantidad: it.cantidad ?? '', precio_unitario: it.precio_unitario ?? '', importe: it.importe ?? '' };
    });
  } catch { return []; }
}

// Drive acumulativo de productos (espeja resultados.xlsx pero con productos.xlsx; sin migracion de columnas).
async function appendOrCreateProductsXLSXInDrive(drive, targetFolderId, newProds, log) {
  const FILE = 'productos.xlsx';
  const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const searchRes = await drive.files.list({ q: `name='${FILE}' and '${targetFolderId}' in parents and trashed=false`, fields: 'files(id)', spaces: 'drive' });
  const existing = searchRes.data.files?.[0];
  let existingRows = [];
  if (existing) {
    const dlRes = await drive.files.get({ fileId: existing.id, alt: 'media' }, { responseType: 'arraybuffer' });
    const wb0 = XLSX.read(Buffer.from(dlRes.data), { type: 'buffer' });
    existingRows = XLSX.utils.sheet_to_json(wb0.Sheets[wb0.SheetNames[0]], { defval: '' });
  }
  const mapRow = (p) => { const o = {}; PRODUCT_COLUMNS.forEach(c => { const lbl = PRODUCT_LABELS[c]; o[lbl] = p[lbl] ?? p[c] ?? ''; }); return o; };
  const allRows = [...existingRows.map(mapRow), ...newProds.map(mapRow)];
  const ws = XLSX.utils.json_to_sheet(allRows, { header: PRODUCT_COLUMNS.map(c => PRODUCT_LABELS[c]) });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Productos');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const { Readable } = await import('node:stream');
  if (existing) {
    await drive.files.update({ fileId: existing.id, media: { mimeType, body: Readable.from(buffer) } });
    return existing.id;
  }
  const cr = await drive.files.create({ requestBody: { name: FILE, parents: [targetFolderId], mimeType }, media: { mimeType, body: Readable.from(buffer) }, fields: 'id' });
  return cr.data.id;
}

async function depositProductsToDriveAccumulative(credentials, outputFolderName, prods, log, clientFolderName) {
  const refreshToken = credentials.oauth_refresh_token;
  const folderId = credentials.folder_id;
  if (!refreshToken || !folderId) return null;
  const drive = createDriveClient(refreshToken);
  let parentFolderId = folderId;
  if (clientFolderName) parentFolderId = await ensureOutputFolder(drive, folderId, clientFolderName, log);
  const targetFolderId = await ensureOutputFolder(drive, parentFolderId, outputFolderName || 'extracciones', log);
  return await appendOrCreateProductsXLSXInDrive(drive, targetFolderId, prods, log);
}

// Orquestador: deposita el archivo de productos aparte, gateado por el flag. Best-effort.
async function depositProducts(orgId, jobId, rows, outputConfig, outputFormat, clientFolderName, baseName, isDriveXLSXAccum, log) {
  if (!(await lineItemsEnabledForOrg(orgId))) return;
  const prods = await fetchProductsForRows(rows);
  if (prods.length === 0) return;
  const type = outputConfig.integration_type;
  try {
    if (type === 'google_drive' && isDriveXLSXAccum) {
      const fid = await depositProductsToDriveAccumulative(outputConfig.credentials, outputConfig.output_folder_path || 'extracciones', prods, log, clientFolderName);
      log('info', 'output.products_deposited', { job_id: jobId, filename: 'productos.xlsx', format: 'xlsx_accum', drive_file_id: fid, count: prods.length });
      return;
    }
    const isXlsx  = outputFormat === 'xlsx';
    const content = isXlsx ? productsToXLSX(prods) : productsToCSV(prods);
    const fname   = `${baseName}_productos.${isXlsx ? 'xlsx' : 'csv'}`;
    const mime    = isXlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv';
    if (type === 'google_drive') {
      await depositToDrive(outputConfig.credentials, outputConfig.output_folder_path || 'extracciones', fname, content, mime, log, clientFolderName);
    } else if (type === 'sftp') {
      await depositToSftp(outputConfig.credentials, outputConfig.folder_path ?? '/', outputConfig.output_folder_path, fname, content, log);
    } else if (type === 'ftp') {
      await depositToFtp(outputConfig.credentials, outputConfig.folder_path ?? '/', outputConfig.output_folder_path, fname, content, log);
    } else if (type === 'firebase_storage') {
      await depositToFirebaseStorage(outputConfig.credentials, outputConfig.output_folder_path || 'extracciones', fname, content, log);
    } else if (type === 'supabase_storage') {
      await depositToSupabaseStorage(outputConfig.credentials, outputConfig, fname, content, log);
    } else { return; }
    log('info', 'output.products_deposited', { job_id: jobId, filename: fname, format: outputFormat, count: prods.length });
  } catch (err) {
    log('warn', 'output.products_failed', { job_id: jobId, error: err.message });
  }
}

async function depositToDrive(credentials, outputFolderName, filename, fileContent, mimeType, log, clientFolderName = null) {
  const refreshToken = credentials.oauth_refresh_token;
  if (!refreshToken) throw new Error('Google Drive: oauth_refresh_token no configurado');

  const folderId = credentials.folder_id;
  if (!folderId) throw new Error('Google Drive: folder_id no configurado');

  const drive = createDriveClient(refreshToken);

  // Si hay cliente: depositar dentro de {cliente}/extracciones/
  // Si no: depositar en raíz/{outputFolderName} (retrocompatibilidad)
  let parentFolderId = folderId;
  if (clientFolderName) {
    parentFolderId = await ensureOutputFolder(drive, folderId, clientFolderName, log);
  }
  const targetFolderId = await ensureOutputFolder(drive, parentFolderId, outputFolderName || 'extracciones', log);

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

async function depositToFirebaseStorage(credentials, outputFolderName, filename, fileContent, log) {
  const { initializeApp, deleteApp, cert } = await import('firebase-admin/app');
  const { getStorage } = await import('firebase-admin/storage');

  const serviceAccount = typeof credentials.service_account_json === 'string'
    ? JSON.parse(credentials.service_account_json)
    : credentials.service_account_json;

  const bucketName   = credentials.bucket_name;
  const folderPath   = credentials.folder_path || '';
  const outputFolder = outputFolderName || 'extracciones';

  if (!serviceAccount || !bucketName) {
    throw new Error('Firebase Storage: service_account_json y bucket_name son requeridos');
  }

  const appName = `dl_output_${Date.now()}`;
  const app = initializeApp({
    credential: cert(serviceAccount),
    storageBucket: bucketName,
  }, appName);

  try {
    const bucket = getStorage(app).bucket();

    const prefix   = folderPath ? (folderPath.endsWith('/') ? folderPath : `${folderPath}/`) : '';
    const destPath = `${prefix}${outputFolder}/${filename}`;

    const buf = Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent, 'utf-8');
    await bucket.file(destPath).save(buf, { resumable: false });

    log('info', 'output.firebase_upload_done', { bucket: bucketName, path: destPath });
    return destPath;
  } finally {
    await deleteApp(app);
  }
}

async function depositToSupabaseStorage(credentials, outputConfig, filename, fileContent, log) {
  const { project_url: projectUrl, service_role_key: serviceRoleKey, bucket_name: bucketName } = credentials ?? {};

  if (!projectUrl || !serviceRoleKey || !bucketName) {
    throw new Error('Supabase Storage output: project_url, service_role_key y bucket_name son requeridos');
  }

  // folder_path puede estar en outputConfig (columna top-level) o en credentials (legacy)
  const rawFolder = (outputConfig.folder_path ?? credentials.folder_path ?? '').trim().replace(/^\/+/, '');
  const prefix    = rawFolder ? (rawFolder.endsWith('/') ? rawFolder : `${rawFolder}/`) : '';
  const destPath  = `${prefix}extracciones/${filename}`;

  const buf = Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent, 'utf-8');
  const res = await fetch(`${projectUrl}/storage/v1/object/${bucketName}/${destPath}`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${serviceRoleKey}`,
      'apikey':        serviceRoleKey,
      'Content-Type':  filename.endsWith('.xlsx')
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'text/csv',
      'x-upsert': 'true', // sobrescribir si existe (múltiples jobs del mismo día)
    },
    body: buf,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase Storage upload failed (${res.status}): ${txt}`);
  }

  log('info', 'output.supabase_upload_done', { bucket: bucketName, path: destPath });
  return destPath;
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
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    log('warn', 'output.no_env', { job_id: jobId, note: 'SUPABASE_URL o SUPABASE_KEY no configurados' });
    return { outputFeatures: [] };
  }

  // 1. Verificar si el org tiene output habilitado
  let outputConfig;
  try {
    const res = await supabaseFetch('/rest/v1/rpc/admin_get_output_integration', {
      method: 'POST',
      body: JSON.stringify({ p_organization_id: orgId }),
    });
    if (!res.ok) {
      const errText = await res.text();
      log('warn', 'output.config_rpc_error', { job_id: jobId, http_status: res.status, error: errText });
      return { outputFeatures: [] };
    }
    const data = await res.json();
    if (!data || data.length === 0) {
      log('info', 'output.no_output_config', { job_id: jobId, organization_id: orgId, note: 'Sin integración de salida activa' });
      return { outputFeatures: [] };
    }
    outputConfig = Array.isArray(data) ? data[0] : data;
  } catch (err) {
    log('warn', 'output.config_fetch_failed', { job_id: jobId, error: err.message });
    return { outputFeatures: [] };
  }

  const outputFormat = outputConfig.output_format ?? 'csv';

  // 2. Resolver carpeta de cliente para Drive (best-effort, no bloqueante)
  let clientFolderName = null;
  if (outputConfig.integration_type === 'google_drive') {
    try {
      const jobRes = await supabaseFetch(
        `/rest/v1/pdf_jobs?id=eq.${encodeURIComponent(jobId)}&select=client_id&limit=1`
      );
      if (jobRes.ok) {
        const jobData = await jobRes.json();
        const clientId = jobData?.[0]?.client_id;
        if (clientId) {
          clientFolderName = await fetchClientFolderName(orgId, clientId, log);
        }
      }
    } catch (err) {
      log('warn', 'output.client_resolve_failed', { job_id: jobId, error: err.message });
    }
  }

  // Detectar features de output activas para billing (TASK-75)
  const isDriveXLSXAccum = outputConfig.integration_type === 'google_drive'
    && outputFormat === 'xlsx'
    && clientFolderName !== null;

  const outputFeatures = isDriveXLSXAccum
    ? ['master_file']
    : outputFormat === 'xlsx'
      ? ['xlsx_output']
      : [];

  log('info', 'output.deposit_start', {
    job_id:           jobId,
    organization_id:  orgId,
    integration_type: outputConfig.integration_type,
    format:           outputFormat,
    client_folder:    clientFolderName ?? 'none',
    output_features:  outputFeatures,
  });

  // 4. Obtener filas del job (solo doc_status=ok — failed/warning/pending_approval se excluyen)
  let rows;
  try {
    const res = await supabaseFetch(
      `/rest/v1/pdf_job_rows?job_id=eq.${encodeURIComponent(jobId)}&doc_status=eq.ok&select=id,${COLUMNS.join(',')}&order=id.asc`
    );
    if (!res.ok) throw new Error(`pdf_job_rows fetch failed: ${res.status}`);
    rows = await res.json();
  } catch (err) {
    log('warn', 'output.rows_fetch_failed', { job_id: jobId, error: err.message });
    return { outputFeatures };
  }

  if (!rows || rows.length === 0) {
    log('info', 'output.no_rows', { job_id: jobId });
    return { outputFeatures };
  }

  // 5. Generar archivo según formato
  // Drive + xlsx + cliente usa modo acumulativo: no genera archivo aquí, lo hace depositToDriveAccumulative
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  let fileContent, filename, mimeType;

  // FILE-RENAME-BY-DATA (Fase 1): para storage (Supabase/Firebase) y 1 documento con los 3 datos
  // clave -> nombre por dato {cuit}_{numero}_{codigo_afip}. Drive (acumulativo) y multi-doc quedan
  // con el nombre por defecto (resultado_...). Si falta algun dato, buildDocFileBase devuelve null.
  const renameBase = (rows.length === 1
      && ['supabase_storage', 'firebase_storage'].includes(outputConfig.integration_type))
    ? buildDocFileBase(rows[0]) : null;
  const baseName = renameBase ?? `resultado_${jobId.slice(0, 8)}_${timestamp}`;

  // DEDUP (marcado UNIVERSAL): misma factura (cuit + punto_venta + numero) ya procesada antes en la
  // org -> se marca is_duplicate/has_duplicate (badge "Duplicado" en la app) en CUALQUIER flujo con
  // salida (storage/Drive/etc.), no solo storage. El "no depositar la salida del duplicado" se mantiene
  // por ahora SOLO en storage (renameBase); Drive/otros marcan pero siguen depositando (excluir el
  // duplicado de la salida en Drive = paso aparte).
  if (rows.length === 1 && rows[0].cuit && rows[0].numero_comprobante) {
    const dup = await hasEarlierDuplicate(orgId, rows[0].id, rows[0].cuit, rows[0].punto_venta, rows[0].numero_comprobante, log);
    if (dup) {
      await markDuplicate(rows[0].id, jobId, log);
      log('info', 'output.duplicate_marked', { job_id: jobId, row_id: rows[0].id, skip_output: true });
      return { outputFeatures };  // duplicado -> NO deposita salida (ni facturas ni productos) en ningún flujo
    }
  }

  if (!isDriveXLSXAccum) {
    if (outputFormat === 'xlsx') {
      fileContent = rowsToXLSX(rows);
      filename    = `${baseName}.xlsx`;
      mimeType    = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    } else {
      fileContent = rowsToCSV(rows);
      filename    = `${baseName}.csv`;
      mimeType    = 'text/csv';
    }
  }

  // 6. Depositar según tipo de integración
  try {
    if (outputConfig.integration_type === 'google_drive') {
      if (isDriveXLSXAccum) {
        const fileId = await depositToDriveAccumulative(
          outputConfig.credentials,
          outputConfig.output_folder_path || 'extracciones',
          rows,
          log,
          clientFolderName
        );
        log('info', 'output.deposited', {
          job_id: jobId, organization_id: orgId,
          integration_type: 'google_drive', filename: 'resultados.xlsx', format: 'xlsx_accum',
          drive_file_id: fileId,
        });
      } else {
        const fileId = await depositToDrive(
          outputConfig.credentials,
          outputConfig.output_folder_path || 'extracciones',
          filename,
          fileContent,
          mimeType,
          log,
          clientFolderName
        );
        log('info', 'output.deposited', {
          job_id: jobId, organization_id: orgId,
          integration_type: 'google_drive', filename, format: outputFormat,
          drive_file_id: fileId,
        });
      }

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

    } else if (outputConfig.integration_type === 'firebase_storage') {
      const destPath = await depositToFirebaseStorage(
        outputConfig.credentials,
        outputConfig.output_folder_path || 'extracciones',
        filename,
        fileContent,
        log
      );
      log('info', 'output.deposited', {
        job_id: jobId, organization_id: orgId,
        integration_type: 'firebase_storage', filename, format: outputFormat,
        dest_path: destPath,
      });

    } else if (outputConfig.integration_type === 'supabase_storage') {
      const destPath = await depositToSupabaseStorage(
        outputConfig.credentials,
        outputConfig,
        filename,
        fileContent,
        log
      );
      log('info', 'output.deposited', {
        job_id: jobId, organization_id: orgId,
        integration_type: 'supabase_storage', filename, format: outputFormat,
        dest_path: destPath,
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

  // LINE-ITEMS Fase 4: archivo de productos aparte (gateado por line_items_enabled). Best-effort.
  await depositProducts(orgId, jobId, rows, outputConfig, outputFormat, clientFolderName, baseName, isDriveXLSXAccum, log);

  return { outputFeatures };
}

// ─── Depósito de una sola fila aprobada (TASK-80) ─────────────────────────────

export async function depositSingleApprovedRow(rowId, jobId, orgId, log) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;

  let outputConfig;
  try {
    const res = await supabaseFetch('/rest/v1/rpc/admin_get_output_integration', {
      method: 'POST',
      body: JSON.stringify({ p_organization_id: orgId }),
    });
    if (!res.ok) { log('warn', 'output.single_row.config_error', { row_id: rowId }); return; }
    const data = await res.json();
    if (!data || data.length === 0) { log('info', 'output.single_row.no_config', { row_id: rowId }); return; }
    outputConfig = Array.isArray(data) ? data[0] : data;
  } catch (err) {
    log('warn', 'output.single_row.config_failed', { row_id: rowId, error: err.message });
    return;
  }

  let rows;
  try {
    const res = await supabaseFetch(
      `/rest/v1/pdf_job_rows?id=eq.${encodeURIComponent(rowId)}&select=${COLUMNS.join(',')}`
    );
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    rows = await res.json();
  } catch (err) {
    log('warn', 'output.single_row.fetch_failed', { row_id: rowId, error: err.message });
    return;
  }

  if (!rows || rows.length === 0) {
    log('warn', 'output.single_row.not_found', { row_id: rowId });
    return;
  }

  const outputFormat = outputConfig.output_format ?? 'csv';

  // FILE-RENAME-BY-DATA Fase 2: nombre por dato del CSV/xlsx aprobado en storage (Supabase/Firebase).
  const renameBase = ['supabase_storage', 'firebase_storage'].includes(outputConfig.integration_type)
    ? buildDocFileBase(rows[0]) : null;

  // FILE-RENAME-BY-DATA Fase 2: duplicado → no se deposita salida (mismo criterio que el path automático).
  if (renameBase) {
    const dup = await hasEarlierDuplicate(orgId, rowId, rows[0].cuit, rows[0].punto_venta, rows[0].numero_comprobante, log);
    if (dup) {
      await markDuplicate(rowId, jobId, log);
      log('info', 'output.single_row.skip_duplicate', { row_id: rowId, job_id: jobId });
      return;
    }
  }

  let clientFolderName = null;
  if (outputConfig.integration_type === 'google_drive') {
    try {
      const jobRes = await supabaseFetch(
        `/rest/v1/pdf_jobs?id=eq.${encodeURIComponent(jobId)}&select=client_id&limit=1`
      );
      if (jobRes.ok) {
        const jobData = await jobRes.json();
        const clientId = jobData?.[0]?.client_id;
        if (clientId) clientFolderName = await fetchClientFolderName(orgId, clientId, log);
      }
    } catch { /* best-effort */ }
  }

  const isDriveXLSXAccum = outputConfig.integration_type === 'google_drive'
    && outputFormat === 'xlsx'
    && clientFolderName !== null;

  const timestamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');

  try {
    if (outputConfig.integration_type === 'google_drive') {
      if (isDriveXLSXAccum) {
        // Acumulativo: agrega solo esta fila nueva al resultados.xlsx (sin duplicar las anteriores)
        await depositToDriveAccumulative(
          outputConfig.credentials,
          outputConfig.output_folder_path || 'extracciones',
          rows, log, clientFolderName
        );
      } else {
        const ext = outputFormat === 'xlsx' ? 'xlsx' : 'csv';
        const filename = `aprobado_${String(rowId)}_${timestamp}.${ext}`;
        const fileContent = outputFormat === 'xlsx' ? rowsToXLSX(rows) : rowsToCSV(rows);
        const mimeType = outputFormat === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv';
        await depositToDrive(
          outputConfig.credentials, outputConfig.output_folder_path || 'extracciones',
          filename, fileContent, mimeType, log, clientFolderName
        );
      }
    } else if (outputConfig.integration_type === 'sftp') {
      const ext = outputFormat === 'xlsx' ? 'xlsx' : 'csv';
      const filename = `aprobado_${String(rowId)}_${timestamp}.${ext}`;
      const fileContent = outputFormat === 'xlsx' ? rowsToXLSX(rows) : rowsToCSV(rows);
      await depositToSftp(
        outputConfig.credentials, outputConfig.folder_path ?? '/',
        outputConfig.output_folder_path, filename, fileContent, log
      );
    } else if (outputConfig.integration_type === 'ftp') {
      const ext = outputFormat === 'xlsx' ? 'xlsx' : 'csv';
      const filename = `aprobado_${String(rowId)}_${timestamp}.${ext}`;
      const fileContent = outputFormat === 'xlsx' ? rowsToXLSX(rows) : rowsToCSV(rows);
      await depositToFtp(
        outputConfig.credentials, outputConfig.folder_path ?? '/',
        outputConfig.output_folder_path, filename, fileContent, log
      );
    } else if (outputConfig.integration_type === 'firebase_storage') {
      const ext = outputFormat === 'xlsx' ? 'xlsx' : 'csv';
      const filename = `${renameBase ?? `aprobado_${String(rowId)}_${timestamp}`}.${ext}`;
      const fileContent = outputFormat === 'xlsx' ? rowsToXLSX(rows) : rowsToCSV(rows);
      await depositToFirebaseStorage(
        outputConfig.credentials, outputConfig.output_folder_path || 'extracciones',
        filename, fileContent, log
      );
    } else if (outputConfig.integration_type === 'supabase_storage') {
      // Gap preexistente: faltaba la rama supabase en el path de aprobación. Agregada en Fase 2.
      const ext = outputFormat === 'xlsx' ? 'xlsx' : 'csv';
      const filename = `${renameBase ?? `aprobado_${String(rowId)}_${timestamp}`}.${ext}`;
      const fileContent = outputFormat === 'xlsx' ? rowsToXLSX(rows) : rowsToCSV(rows);
      await depositToSupabaseStorage(
        outputConfig.credentials, outputConfig, filename, fileContent, log
      );
    }
    log('info', 'output.single_row.deposited', {
      row_id: rowId, job_id: jobId, integration_type: outputConfig.integration_type,
    });
  } catch (err) {
    log('warn', 'output.single_row.deposit_failed', { row_id: rowId, error: err.message });
  }
}
