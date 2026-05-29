/**
 * dlq-processor.mjs — Dead Letter Queue processor
 * Data Laundering V2.0 — TASK-27 / QUEUE-002-b
 *
 * Corre como cron cada hora. Detecta jobs que agotaron todos los intentos
 * y los registra como 'dead' en Supabase queue_jobs.
 *
 * Uso standalone: REDIS_HOST=... REDIS_PASSWORD=... node dlq-processor.mjs
 * En producción: importar y llamar processDLQ() desde un setInterval en worker.mjs
 */

import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const DLQ_ALERT_THRESHOLD = 10;
const QUEUE_NAME = 'pdf-processing';

export async function processDLQ({ connection, supabaseUrl, supabaseKey, log }) {
  const queue = new Queue(QUEUE_NAME, { connection });

  try {
    const failed = await queue.getFailed(0, 100);

    if (failed.length === 0) {
      log('info', 'dlq.empty', { message: 'Sin jobs fallidos en la cola' });
      return;
    }

    // Alerta si supera el umbral
    if (failed.length >= DLQ_ALERT_THRESHOLD) {
      log('warn', 'dlq.alert', {
        count: failed.length,
        threshold: DLQ_ALERT_THRESHOLD,
        message: `DLQ tiene ${failed.length} jobs fallidos — revisar urgente`,
      });
    }

    log('info', 'dlq.processing', { count: failed.length });

    for (const job of failed) {
      const maxAttempts = job.opts?.attempts ?? 3;
      const isDead = job.attemptsMade >= maxAttempts;

      if (!isDead) continue;

      // Registrar como 'dead' en Supabase queue_jobs
      try {
        const res = await fetch(
          `${supabaseUrl}/rest/v1/queue_jobs?pdf_job_id=eq.${encodeURIComponent(job.data.job_id)}`,
          {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
              'Prefer': 'return=minimal',
            },
            body: JSON.stringify({
              status: 'dead',
              last_error: job.failedReason ?? 'Agotó todos los intentos',
              completed_at: new Date().toISOString(),
            }),
          }
        );

        if (!res.ok) {
          log('warn', 'dlq.supabase_update_failed', {
            job_id: job.data.job_id,
            http_status: res.status,
          });
        } else {
          log('info', 'dlq.marked_dead', {
            job_id: job.data.job_id,
            attempts: job.attemptsMade,
            reason: job.failedReason,
          });
        }
      } catch (err) {
        log('warn', 'dlq.supabase_error', {
          job_id: job.data.job_id,
          error: err.message,
        });
      }
    }
  } finally {
    await queue.close();
  }
}

// ─── Modo standalone ─────────────────────────────────────────────────────────
if (process.argv[1].endsWith('dlq-processor.mjs')) {
  const WORKER_VERSION = '0.1.0';

  function log(level, event, data = {}) {
    console.log(JSON.stringify({
      level, event, worker_version: WORKER_VERSION,
      timestamp: new Date().toISOString(), ...data,
    }));
  }

  const connection = new IORedis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT ?? 16705),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  await processDLQ({
    connection,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_SERVICE_KEY,
    log,
  });

  await connection.quit();
  log('info', 'dlq.done', {});
  process.exit(0);
}
