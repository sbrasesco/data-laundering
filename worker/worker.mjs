/**
 * worker.mjs — BullMQ Worker v0.2.0 (shadow mode + retry logic)
 * Data Laundering V2.0 — TASK-42 + TASK-27
 *
 * v0.2.0: Agrega clasificación de errores (RetryableError/TerminalError)
 *         y cron de DLQ cada hora.
 * v0.1.0: Shadow mode — conecta y loguea jobs sin procesar.
 */

import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { RetryableError, TerminalError, toUnrecoverable } from './errors.mjs';
import { processDLQ } from './dlq-processor.mjs';
import { insertQueueJob, syncJobState } from './persistence.mjs';
import { startMetricsServer } from './metrics.mjs';

const WORKER_VERSION = process.env.WORKER_VERSION ?? '0.3.0';
const QUEUE_NAME = 'pdf-processing';
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 3);
const DLQ_INTERVAL_MS = 60 * 60 * 1000; // 1 hora

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
    const jobId = job.data.job_id;
    const attempt = job.attemptsMade + 1;

    log('info', 'job.received', {
      job_id: jobId,
      organization_id: job.data.organization_id,
      file_type: job.data.file_type,
      original_filename: job.data.original_filename,
      attempt,
    });

    // Registrar job en Supabase (upsert) y marcar como 'processing'
    await insertQueueJob(job, log);
    await syncJobState(job, 'active', {}, log);

    try {
      // v0.2.0: shadow mode — no procesa, solo loguea
      // TODO (Fase 2): llamar sub-workflow n8n por cada documento
      log('info', 'job.shadow_skip', {
        job_id: jobId,
        note: 'Worker v0 shadow mode — procesamiento pendiente Fase 2',
      });

      const result = { status: 'shadow_logged', worker_version: WORKER_VERSION };
      await syncJobState(job, 'completed', { result }, log);
      return result;

    } catch (err) {
      // Clasificar el error para decidir si BullMQ debe reintentar
      if (err instanceof TerminalError) {
        log('error', 'job.terminal_error', {
          job_id: jobId,
          error: err.message,
          attempt,
          note: 'Sin retry — error permanente',
        });
        await syncJobState(job, 'dead', { error: err.message }, log);
        throw toUnrecoverable(err);
      }

      // RetryableError u otros errores → BullMQ reintenta con backoff exponencial
      log('warn', 'job.retryable_error', {
        job_id: jobId,
        error: err.message,
        attempt,
        note: 'BullMQ reintentará con backoff exponencial',
      });
      await syncJobState(job, 'failed', { error: err.message }, log);
      throw err;
    }
  },
  {
    connection,
    concurrency: CONCURRENCY,
    limiter: {
      max: Number(process.env.WORKER_RATE_MAX ?? 10),
      duration: Number(process.env.WORKER_RATE_DURATION_MS ?? 1000),
    },
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
    is_terminal: err.name === 'UnrecoverableError',
  })
);

worker.on('error', (err) =>
  log('error', 'worker.error', { message: err.message })
);

// ─── Cron de DLQ (cada hora) ─────────────────────────────────────────────────
async function runDLQCron() {
  log('info', 'dlq.cron_start', {});
  try {
    await processDLQ({
      connection,
      supabaseUrl: process.env.SUPABASE_URL,
      supabaseKey: process.env.SUPABASE_SERVICE_KEY,
      log,
    });
  } catch (err) {
    log('error', 'dlq.cron_error', { error: err.message });
  }
}

// Correr inmediatamente al arrancar, luego cada hora
runDLQCron();
const dlqInterval = setInterval(runDLQCron, DLQ_INTERVAL_MS);

// ─── Queue (para métricas — lectura de stats) ────────────────────────────────
const queue = new Queue(QUEUE_NAME, { connection });

// ─── Servidor de métricas ─────────────────────────────────────────────────────
const metricsServer = startMetricsServer(queue, log);

// ─── Graceful shutdown ───────────────────────────────────────────────────────
async function shutdown(signal) {
  log('info', 'worker.shutdown', { signal });
  clearInterval(dlqInterval);
  metricsServer.close();
  await worker.close();
  await queue.close();
  await connection.quit();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

log('info', 'worker.started', {
  concurrency: CONCURRENCY,
  dlq_interval_hours: 1,
  note: 'Conectado. Esperando jobs...',
});
