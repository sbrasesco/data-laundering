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
import { startGateway } from './gateway.mjs';
import { processZip } from './zip-processor.mjs';
import { processDocumentResult, finalizeJob, failJob } from './post-processor.mjs';

const N8N_SUB_WORKFLOW_URL = process.env.N8N_SUB_WORKFLOW_URL ?? 'https://automation.aignition.net/webhook/sub-document';

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
      const fileType = job.data.file_type ?? 'pdf';

      // ── ZIP: descomprimir + split + llamar sub-workflow por cada doc ─────────
      if (fileType === 'zip') {
        log('info', 'job.zip_start', { job_id: jobId, file_url: job.data.file_url });

        const documents = await processZip(job.data, log);
        log('info', 'job.zip_extracted', { job_id: jobId, total_docs: documents.length });

        let successful = 0, failed = 0, lowConfidence = 0;
        const orgId = job.data.organization_id;

        for (const doc of documents) {
          try {
            const res = await fetch(N8N_SUB_WORKFLOW_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                job_id: jobId,
                organization_id: orgId,
                file_url: doc.file_url,
                file_type: doc.file_type,
                original_filename: doc.original_filename,
                client_cuit: doc.client_cuit,
                client_name: doc.client_name,
                oc_entries: doc.oc_entries,
                input_source: job.data.metadata?.source ?? 'frontend_upload',
              }),
            });
            const data = await res.json();
            if (data.success) {
              successful++;
              log('info', 'job.doc_done', { job_id: jobId, file: doc.original_filename, row_id: data.row_id });
              // Post-extracción: evaluar confianza + audit log
              await processDocumentResult(data, jobId, orgId, log);
              if ((data.confidence_score ?? 1) < 0.8) lowConfidence++;
            } else {
              failed++;
              log('warn', 'job.doc_error', { job_id: jobId, file: doc.original_filename, error: data.error });
            }
          } catch (err) {
            failed++;
            log('warn', 'job.doc_fetch_error', { job_id: jobId, file: doc.original_filename, error: err.message });
          }
        }

        // Finalizar job en pdf_jobs
        await finalizeJob(jobId, { total: documents.length, successful, failed, lowConfidence }, log);

        const result = { status: failed > 0 ? 'done_with_warnings' : 'done', successful, failed, lowConfidence, total: documents.length, worker_version: WORKER_VERSION };
        await syncJobState(job, 'completed', { result }, log);
        return result;
      }

      // ── Documento individual: llamar sub-workflow directamente ───────────────
      if (['pdf', 'jpg', 'jpeg', 'png'].includes(fileType)) {
        log('info', 'job.single_doc_start', { job_id: jobId, file_type: fileType });
        const res = await fetch(N8N_SUB_WORKFLOW_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            job_id: jobId,
            organization_id: job.data.organization_id,
            file_url: job.data.file_url,
            file_type: fileType,
            original_filename: job.data.original_filename,
            client_cuit: job.data.client_cuit ?? null,
            client_name: job.data.client_name ?? null,
            oc_entries: job.data.oc_entries ?? [],
            input_source: job.data.metadata?.source ?? 'frontend_upload',
          }),
        });
        const data = await res.json();
        const result = { ...data, worker_version: WORKER_VERSION };
        await syncJobState(job, 'completed', { result }, log);
        return result;
      }

      // ── Fallback shadow mode ─────────────────────────────────────────────────
      log('info', 'job.shadow_skip', {
        job_id: jobId,
        note: 'Tipo de archivo no reconocido — shadow mode',
        file_type: fileType,
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
        await failJob(jobId, err.message, log);
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

// ─── Input Gateway ────────────────────────────────────────────────────────────
const gatewayServer = startGateway(queue, log);

// ─── Graceful shutdown ───────────────────────────────────────────────────────
async function shutdown(signal) {
  log('info', 'worker.shutdown', { signal });
  clearInterval(dlqInterval);
  metricsServer.close();
  gatewayServer.close();
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
