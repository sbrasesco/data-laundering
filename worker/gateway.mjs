/**
 * gateway.mjs — Input Gateway: POST /api/enqueue
 * Data Laundering V2.0 — TASK-37
 *
 * Punto de entrada único al pipeline. Cualquier origen (frontend, Drive, FTP,
 * API directa) llama a este endpoint para encolar un job en BullMQ.
 *
 * Puerto: GATEWAY_PORT (default: 3001)
 * Auth:   Authorization: Bearer <GATEWAY_API_KEY>
 */

import { createServer } from 'http';
import { randomUUID } from 'crypto';

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 3001);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY;

const VALID_FILE_TYPES = ['zip', 'pdf', 'jpg', 'jpeg', 'png'];
const VALID_SOURCES = ['frontend_upload', 'integration_drive', 'integration_remote', 'api_direct'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUUID(v) { return UUID_RE.test(v); }

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/**
 * Crea el registro en pdf_jobs y encola en BullMQ.
 * Idempotente: si se llama dos veces con los mismos datos, BullMQ no duplica.
 */
async function handleEnqueue(body, queue, log) {
  const {
    organization_id, file_url, file_type, original_filename,
    client_cuit = null, client_name = null, input_source,
    job_id: provided_job_id = null,
  } = body;

  // ── Validaciones ─────────────────────────────────────────────────────────
  if (!organization_id || !file_url || !file_type || !original_filename || !input_source) {
    return { status: 400, body: { error: 'Campos requeridos: organization_id, file_url, file_type, original_filename, input_source' } };
  }
  if (!isUUID(organization_id)) {
    return { status: 400, body: { error: 'organization_id debe ser un UUID válido' } };
  }
  if (!VALID_FILE_TYPES.includes(file_type)) {
    return { status: 400, body: { error: `file_type inválido. Valores aceptados: ${VALID_FILE_TYPES.join(', ')}` } };
  }
  if (!VALID_SOURCES.includes(input_source)) {
    return { status: 400, body: { error: `input_source inválido. Valores aceptados: ${VALID_SOURCES.join(', ')}` } };
  }
  if (!file_url.startsWith('https://')) {
    return { status: 400, body: { error: 'file_url debe ser una URL HTTPS' } };
  }

  // ── Encolar en BullMQ ─────────────────────────────────────────────────────
  // Si el frontend pasa job_id (el id de pdf_jobs), lo usamos para mantener FK.
  const job_id = (provided_job_id && isUUID(provided_job_id)) ? provided_job_id : randomUUID();
  const payload = {
    job_id,
    organization_id,
    file_url,
    file_type,
    file_hash: 'pending',     // el Worker calculará el hash al descargar
    original_filename,
    file_size_bytes: 0,       // el Worker lo calculará al descargar
    client_cuit,
    client_name,
    oc_entries: [],
    priority: 5,
    metadata: {
      source: input_source,
      worker_version: process.env.WORKER_VERSION ?? 'unknown',
    },
  };

  await queue.add('process-pdf', payload, {
    jobId: job_id,           // idempotente: mismo job_id no duplica
    priority: 5,
  });

  log('info', 'gateway.enqueued', { job_id, organization_id, file_type, input_source });

  return { status: 200, body: { job_id, queued: true } };
}

/**
 * Inicia el servidor HTTP del Input Gateway.
 */
export function startGateway(queue, log) {
  const server = createServer(async (req, res) => {
    // ── Autenticación ──────────────────────────────────────────────────────
    if (GATEWAY_API_KEY) {
      const auth = req.headers['authorization'] ?? '';
      if (auth !== `Bearer ${GATEWAY_API_KEY}`) {
        return json(res, 401, { error: 'Unauthorized' });
      }
    }

    // ── Rutas ──────────────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/health') {
      return json(res, 200, { status: 'ok', gateway: true, worker_version: process.env.WORKER_VERSION });
    }

    if (req.method === 'POST' && req.url === '/api/enqueue') {
      try {
        const body = await readBody(req);
        const result = await handleEnqueue(body, queue, log);
        return json(res, result.status, result.body);
      } catch (err) {
        log('error', 'gateway.request_error', { error: err.message });
        return json(res, 400, { error: err.message });
      }
    }

    json(res, 404, { error: 'Not Found', endpoints: ['POST /api/enqueue', 'GET /health'] });
  });

  server.listen(GATEWAY_PORT, () => {
    log('info', 'gateway.started', {
      port: GATEWAY_PORT,
      auth: GATEWAY_API_KEY ? 'Bearer token' : 'NONE (staging)',
      endpoints: ['POST /api/enqueue', 'GET /health'],
    });
  });

  server.on('error', (err) => {
    log('error', 'gateway.server_error', { message: err.message });
  });

  return server;
}
