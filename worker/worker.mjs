/**
 * worker.mjs — BullMQ Worker v0 (shadow mode)
 * Data Laundering V2.0 — TASK-42
 *
 * v0: Solo conecta a Redis y loguea jobs recibidos.
 * NO procesa nada todavía — eso es Fase 2.
 */

import { Worker } from 'bullmq';
import IORedis from 'ioredis';

const WORKER_VERSION = '0.1.0';
const QUEUE_NAME = 'pdf-processing';
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 3);

// ─── Conexión Redis ──────────────────────────────────────────────────────────
const connection = new IORedis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT ?? 16705),
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

connection.on('connect', () =>
  log('info', 'redis.connected', { host: process.env.REDIS_HOST })
);
connection.on('error', (err) =>
  log('error', 'redis.error', { message: err.message })
);

// ─── Logger estructurado (Pino-compatible) ───────────────────────────────────
function log(level, event, data = {}) {
  console.log(JSON.stringify({
    level,
    event,
    worker_version: WORKER_VERSION,
    queue: QUEUE_NAME,
    timestamp: new Date().toISOString(),
    ...data,
  }));
}

// ─── Worker ──────────────────────────────────────────────────────────────────
const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    log('info', 'job.received', {
      job_id: job.data.job_id,
      organization_id: job.data.organization_id,
      file_type: job.data.file_type,
      original_filename: job.data.original_filename,
      attempt: job.attemptsMade + 1,
    });

    // v0: shadow mode — no procesa, solo loguea
    // TODO (Fase 2): llamar sub-workflow n8n o procesar directamente
    log('info', 'job.shadow_skip', {
      job_id: job.data.job_id,
      note: 'Worker v0 shadow mode — procesamiento pendiente Fase 2',
    });

    return { status: 'shadow_logged', worker_version: WORKER_VERSION };
  },
  {
    connection,
    concurrency: CONCURRENCY,
  }
);

// ─── Eventos del worker ──────────────────────────────────────────────────────
worker.on('completed', (job) =>
  log('info', 'job.completed', { job_id: job.data.job_id })
);

worker.on('failed', (job, err) =>
  log('error', 'job.failed', {
    job_id: job?.data?.job_id,
    error: err.message,
    attempt: job?.attemptsMade,
  })
);

worker.on('error', (err) =>
  log('error', 'worker.error', { message: err.message })
);

// ─── Graceful shutdown ───────────────────────────────────────────────────────
async function shutdown(signal) {
  log('info', 'worker.shutdown', { signal });
  await worker.close();
  await connection.quit();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

log('info', 'worker.started', {
  concurrency: CONCURRENCY,
  note: 'Conectado. Esperando jobs...',
});
