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
import { startBullBoard } from './bull-board.mjs';
import { processZip, extractAttachmentsFromPdf } from './zip-processor.mjs';
import { mkdir, rm } from 'fs/promises';
import { basename } from 'path';
import { processDocumentResult, finalizeJob, failJob } from './post-processor.mjs';
import { processDocument } from './document-processor.mjs';
import { pollGoogleDriveIntegrations }      from './integration-poller.mjs';
import { pollFtpSftpIntegrations }          from './ftp-sftp-poller.mjs';
import { pollFirebaseStorageIntegrations }  from './firebase-storage-poller.mjs';

// DEC-011: n8n eliminado del pipeline. Todo procesamiento va directo a document-processor.mjs.
// DEC-012: chequeo de créditos antes de llamar a Mistral/OpenAI.
const WORKER_VERSION           = process.env.WORKER_VERSION     ?? '0.8.0';
const INTEGRATION_POLL_INTERVAL_MS = 60 * 1000; // 1 min — el poller filtra qué tenants están "due"
const GATEWAY_URL              = process.env.GATEWAY_URL ?? 'https://automation.aignition.net/worker';
const GATEWAY_API_KEY          = process.env.GATEWAY_API_KEY ?? '';
const QUEUE_NAME      = 'pdf-processing';
const CONCURRENCY     = Number(process.env.WORKER_CONCURRENCY ?? 3);
const DLQ_INTERVAL_MS = 60 * 60 * 1000; // 1 hora
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY;

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

// ─── Credit check (DEC-012) ──────────────────────────────────────────────────

async function getBalance(organizationId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/organization_credits?organization_id=eq.${encodeURIComponent(organizationId)}&select=balance`,
    {
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    }
  );
  if (!res.ok) throw new Error(`Error consultando balance: ${res.status}`);
  const data = await res.json();
  return data[0]?.balance ?? 0;
}

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
      if (['zip', 'rar'].includes(fileType)) {
        log('info', 'job.zip_start', { job_id: jobId, file_url: job.data.file_url, file_type: fileType });

        const { documents, failedUploads } = await processZip(job.data, log);
        log('info', 'job.zip_extracted', {
          job_id: jobId,
          total_docs: documents.length,
          failed_uploads: failedUploads,
        });

        const orgId = job.data.organization_id;

        // DEC-012: chequear balance vs documentos a procesar ANTES de llamar a Mistral
        const docsToProcess = documents.length;
        if (docsToProcess > 0) {
          const balance = await getBalance(orgId);
          if (balance < docsToProcess) {
            const msg = `Saldo insuficiente: tenés ${balance} crédito${balance !== 1 ? 's' : ''}, el ZIP tiene ${docsToProcess} documento${docsToProcess !== 1 ? 's' : ''}. Cargá ${docsToProcess - balance} crédito${docsToProcess - balance !== 1 ? 's' : ''} más.`;
            log('warn', 'job.insufficient_credits', { job_id: jobId, organization_id: orgId, balance, docs_needed: docsToProcess });
            throw new TerminalError(msg, { code: 'INSUFFICIENT_CREDITS' });
          }
          log('info', 'job.credits_ok', { job_id: jobId, balance, docs_needed: docsToProcess });
        }

        let successful = 0, failed = failedUploads, lowConfidence = 0;

        for (const doc of documents) {
          try {
            const docPayload = {
              job_id:            jobId,
              organization_id:   orgId,
              file_url:          doc.file_url,
              file_type:         doc.file_type,
              original_filename: doc.original_filename,
              client_cuit:       doc.client_cuit,
              client_name:       doc.client_name,
              oc_entries:        doc.oc_entries,
              input_source:      job.data.metadata?.source ?? 'frontend_upload',
            };

            const data = await processDocument(docPayload, log);
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
        const totalAttempted = documents.length + failedUploads;
        await finalizeJob(jobId, orgId, { total: totalAttempted, successful, failed, lowConfidence }, log);

        const result = { status: failed > 0 ? 'done_with_warnings' : 'done', successful, failed, failedUploads, lowConfidence, total: totalAttempted, worker_version: WORKER_VERSION };
        await syncJobState(job, 'completed', { result }, log);
        return result;
      }

      // ── Documento individual ─────────────────────────────────────────────────
      if (['pdf', 'jpg', 'jpeg', 'png'].includes(fileType)) {
        log('info', 'job.single_doc_start', { job_id: jobId, file_type: fileType });

        // DEC-012: chequear balance >= 1 antes de llamar a Mistral
        const balance = await getBalance(job.data.organization_id);
        if (balance < 1) {
          const msg = 'Saldo insuficiente: no tenés créditos disponibles. Cargá créditos para continuar.';
          log('warn', 'job.insufficient_credits', { job_id: jobId, organization_id: job.data.organization_id, balance });
          throw new TerminalError(msg, { code: 'INSUFFICIENT_CREDITS' });
        }

        // Extraer adjuntos embebidos (OCs) si el archivo es un PDF
        let ocEntries = job.data.oc_entries ?? [];
        const tmpDir = `/tmp/worker-single/${jobId}`;
        if (fileType === 'pdf') {
          try {
            await mkdir(tmpDir, { recursive: true });
            const tmpPdf = `${tmpDir}/input.pdf`;
            const adjDir = `${tmpDir}/adj`;
            const { exec } = await import('child_process');
            const { promisify } = await import('util');
            const execAsync = promisify(exec);
            await execAsync(`wget -qO "${tmpPdf}" "${job.data.file_url}"`);
            const pdfBase = basename(job.data.original_filename, '.pdf');
            ocEntries = await extractAttachmentsFromPdf(tmpPdf, pdfBase, tmpDir, adjDir, log);
            log('info', 'job.single_oc_extracted', { job_id: jobId, oc_count: ocEntries.length });
          } catch (err) {
            log('warn', 'job.single_oc_error', { job_id: jobId, error: err.message, note: 'Continuando sin OCs' });
          }
        }

        const singlePayload = {
          job_id:            jobId,
          organization_id:   job.data.organization_id,
          file_url:          job.data.file_url,
          file_type:         fileType,
          original_filename: job.data.original_filename,
          client_cuit:       job.data.client_cuit  ?? null,
          client_name:       job.data.client_name  ?? null,
          oc_entries:        ocEntries,
          input_source:      job.data.metadata?.source ?? 'frontend_upload',
        };

        const data = await processDocument(singlePayload, log);

        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});

        if (data.success) {
          await processDocumentResult(data, jobId, job.data.organization_id, log);
        }
        await finalizeJob(jobId, job.data.organization_id, {
          total:         1,
          successful:    data.success ? 1 : 0,
          failed:        data.success ? 0 : 1,
          lowConfidence: (data.confidence_score ?? 1) < 0.8 ? 1 : 0,
        }, log);

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
        const errorType = err.code === 'INSUFFICIENT_CREDITS' ? 'credits' : 'processing';
        await syncJobState(job, 'dead', { error: err.message }, log);
        await failJob(jobId, err.message, log, errorType);
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

// ─── Cron de integraciones (cada 1 min) ──────────────────────────────────────
async function runIntegrationPoller() {
  const ctx = { supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY, gatewayUrl: GATEWAY_URL, gatewayApiKey: GATEWAY_API_KEY, log };
  try {
    await pollGoogleDriveIntegrations(ctx);
  } catch (err) {
    log('error', 'integration.cron_error', { protocol: 'google_drive', error: err.message });
  }
  try {
    await pollFtpSftpIntegrations(ctx);
  } catch (err) {
    log('error', 'integration.cron_error', { protocol: 'ftp_sftp', error: err.message });
  }
  try {
    await pollFirebaseStorageIntegrations(ctx);
  } catch (err) {
    log('error', 'integration.cron_error', { protocol: 'firebase_storage', error: err.message });
  }
}

// Primera ejecución con delay de 10s para dar tiempo al worker a conectarse
let integrationInterval;
setTimeout(() => {
  runIntegrationPoller();
  integrationInterval = setInterval(runIntegrationPoller, INTEGRATION_POLL_INTERVAL_MS);
}, 10_000);

// ─── Queue (para métricas — lectura de stats) ────────────────────────────────
const queue = new Queue(QUEUE_NAME, { connection });

// ─── Servidor de métricas ─────────────────────────────────────────────────────
const metricsServer = startMetricsServer(queue, log);

// ─── Input Gateway ────────────────────────────────────────────────────────────
const gatewayServer = startGateway(queue, log);

// ─── Bull Board (dashboard de cola) ──────────────────────────────────────────
const bullBoardServer = startBullBoard(queue, log);

// ─── Graceful shutdown ───────────────────────────────────────────────────────
async function shutdown(signal) {
  log('info', 'worker.shutdown', { signal });
  clearInterval(dlqInterval);
  if (integrationInterval) clearInterval(integrationInterval);
  metricsServer.close();
  gatewayServer.close();
  bullBoardServer.close();
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
