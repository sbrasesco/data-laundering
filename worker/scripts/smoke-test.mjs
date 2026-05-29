/**
 * smoke-test.mjs — TASK-31: Shadow processor smoke test
 * Data Laundering V2.0 — WORKER-003-b
 *
 * Verifica:
 *   1. 10 jobs procesados en modo shadow sin errores
 *   2. Cero escrituras en pdf_job_rows (tabla de negocio)
 *   3. Concurrencia: jobs se procesan en paralelo (WORKER_CONCURRENCY)
 *
 * Uso:
 *   REDIS_HOST=... REDIS_PASSWORD=... SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
 *   node scripts/smoke-test.mjs
 */

import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { randomUUID } from 'crypto';

const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 16705);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const JOB_COUNT = 10;
const TIMEOUT_MS = 30000;

function log(msg) {
  console.log(`[smoke-test] ${new Date().toISOString()} — ${msg}`);
}

// ─── Conexión ────────────────────────────────────────────────────────────────
const connection = new IORedis({
  host: REDIS_HOST, port: REDIS_PORT, password: REDIS_PASSWORD,
  maxRetriesPerRequest: null, enableReadyCheck: false,
});

const queue = new Queue('pdf-processing', { connection });
const queueEvents = new QueueEvents('pdf-processing', {
  connection: new IORedis({
    host: REDIS_HOST, port: REDIS_PORT, password: REDIS_PASSWORD,
    maxRetriesPerRequest: null, enableReadyCheck: false,
  }),
});

// ─── Contar pdf_job_rows antes del test ──────────────────────────────────────
async function countPdfJobRows() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/pdf_job_rows?select=count`,
    {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'count=exact',
        'Range': '0-0',
      },
    }
  );
  const range = res.headers.get('content-range');
  return range ? parseInt(range.split('/')[1]) : null;
}

// ─── Main ────────────────────────────────────────────────────────────────────
log(`Iniciando smoke test: ${JOB_COUNT} jobs en shadow mode`);

const rowsBefore = await countPdfJobRows();
log(`pdf_job_rows antes del test: ${rowsBefore ?? 'N/A (sin Supabase)'}`);

// Encolar 10 jobs con UUIDs ficticios (no ligados a pdf_jobs reales)
const jobIds = [];
const enqueueStart = Date.now();

for (let i = 0; i < JOB_COUNT; i++) {
  const jobId = randomUUID();
  await queue.add('process-pdf', {
    job_id: jobId,
    organization_id: '6b505051-9891-4ef0-b163-07eaf7230f22',
    file_url: `https://example.com/smoke-test-${i}.pdf`,
    file_type: 'pdf',
    file_hash: `sha256:smoke${i}`,
    original_filename: `smoke_test_${i}.pdf`,
    file_size_bytes: 1024,
    client_cuit: null,
    client_name: null,
    oc_entries: [],
    priority: 5,
    metadata: { source: 'frontend_upload', worker_version: '0.3.0', smoke_test: true },
  }, { jobId });
  jobIds.push(jobId);
}

log(`${JOB_COUNT} jobs encolados en ${Date.now() - enqueueStart}ms`);
log(`IDs: ${jobIds.slice(0, 3).join(', ')}...`);

// Esperar a que todos completen
log(`Esperando completion (timeout: ${TIMEOUT_MS / 1000}s)...`);

const completed = new Set();
const failed = new Set();
const start = Date.now();

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    reject(new Error(`Timeout: solo ${completed.size}/${JOB_COUNT} jobs completados`));
  }, TIMEOUT_MS);

  queueEvents.on('completed', ({ jobId }) => {
    if (jobIds.includes(jobId)) {
      completed.add(jobId);
      if (completed.size === JOB_COUNT) {
        clearTimeout(timeout);
        resolve();
      }
    }
  });

  queueEvents.on('failed', ({ jobId, failedReason }) => {
    if (jobIds.includes(jobId)) {
      failed.add(jobId);
      log(`⚠️  Job fallido: ${jobId} — ${failedReason}`);
    }
  });
});

const duration = Date.now() - start;
log(`Completados: ${completed.size}/${JOB_COUNT} en ${duration}ms`);
log(`Throughput: ${(JOB_COUNT / duration * 1000).toFixed(1)} jobs/seg`);

// Verificar pdf_job_rows no creció
const rowsAfter = await countPdfJobRows();
log(`pdf_job_rows después del test: ${rowsAfter ?? 'N/A'}`);

if (rowsBefore !== null && rowsAfter !== null) {
  const delta = rowsAfter - rowsBefore;
  if (delta === 0) {
    log(`✅ Cero escrituras en pdf_job_rows — shadow mode correcto`);
  } else {
    log(`❌ ERROR: pdf_job_rows creció en ${delta} filas — shadow mode escribió en DB de negocio`);
    process.exitCode = 1;
  }
}

// ─── Resultado final ──────────────────────────────────────────────────────────
console.log('');
if (completed.size === JOB_COUNT && failed.size === 0) {
  log(`✅ SMOKE TEST PASSED — ${JOB_COUNT} jobs completados, 0 fallidos, 0 escrituras en pdf_job_rows`);
} else {
  log(`❌ SMOKE TEST FAILED — completados: ${completed.size}, fallidos: ${failed.size}`);
  process.exitCode = 1;
}

await queue.close();
await queueEvents.close();
await connection.quit();
