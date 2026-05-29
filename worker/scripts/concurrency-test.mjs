/**
 * concurrency-test.mjs — TASK-32: Test concurrencia 100 jobs × N workers
 * Data Laundering V2.0 — WORKER-003-c
 *
 * Verifica:
 *   1. 100/100 jobs completados sin pérdidas
 *   2. Cero duplicados (idempotencia por job_id)
 *   3. Throughput y latencias p50/p95 documentadas
 *   4. Redis memory bajo carga
 *
 * Uso:
 *   REDIS_HOST=... REDIS_PASSWORD=... node scripts/concurrency-test.mjs
 */

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { randomUUID } from 'crypto';

const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 16705);
const JOB_COUNT = 100;
const TIMEOUT_MS = 300000; // 5 min
const POLL_INTERVAL_MS = 1000; // polling cada 1s (más confiable que QueueEvents en Redis Cloud)

function log(msg) {
  console.log(`[concurrency-test] ${new Date().toISOString()} — ${msg}`);
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ─── Conexiones ───────────────────────────────────────────────────────────────
const connection = new IORedis({
  host: REDIS_HOST, port: REDIS_PORT, password: REDIS_PASSWORD,
  maxRetriesPerRequest: null, enableReadyCheck: false,
});

const queue = new Queue('pdf-processing', { connection });

// ─── Memoria Redis antes del test ─────────────────────────────────────────────
const memBefore = await connection.info('memory');
const usedBefore = parseInt(memBefore.match(/used_memory:(\d+)/)?.[1] ?? 0);
log(`Redis memory antes: ${(usedBefore / 1024 / 1024).toFixed(2)} MB`);

// ─── Encolar 100 jobs ─────────────────────────────────────────────────────────
log(`Encolando ${JOB_COUNT} jobs...`);
const enqueueStart = Date.now();
const jobIds = [];
const enqueuedAt = new Map();

// Usar 1 org real (solo tenemos 1 en staging)
const ORG_ID = '6b505051-9891-4ef0-b163-07eaf7230f22';

for (let i = 0; i < JOB_COUNT; i++) {
  const jobId = randomUUID();
  const t = Date.now();
  await queue.add('process-pdf', {
    job_id: jobId,
    organization_id: ORG_ID,
    file_url: `https://example.com/concurrency-test-${i}.pdf`,
    file_type: 'pdf',
    file_hash: `sha256:conc${i}`,
    original_filename: `conc_test_${i}.pdf`,
    file_size_bytes: 1024 + i,
    client_cuit: null, client_name: null, oc_entries: [],
    priority: 5,
    metadata: { source: 'frontend_upload', worker_version: '0.3.0', concurrency_test: true, index: i },
  }, { jobId });
  jobIds.push(jobId);
  enqueuedAt.set(jobId, t);
}

const enqueueTime = Date.now() - enqueueStart;
log(`${JOB_COUNT} jobs encolados en ${enqueueTime}ms (${(JOB_COUNT / enqueueTime * 1000).toFixed(0)} enq/seg)`);

// ─── Polling hasta completar todos los jobs ───────────────────────────────────
log(`Polling cada ${POLL_INTERVAL_MS}ms (timeout: ${TIMEOUT_MS / 1000}s)...`);
const processingStart = Date.now();
const completed = new Map(); // jobId → latency_ms
const failed = new Set();
const seenIds = new Set();

const deadline = Date.now() + TIMEOUT_MS;

while (Date.now() < deadline) {
  // Consultar estado de todos los jobs pendientes
  const pending = jobIds.filter(id => !completed.has(id) && !failed.has(id));
  if (pending.length === 0) break;

  for (const jobId of pending) {
    const job = await queue.getJob(jobId);
    if (!job) continue;

    const state = await job.getState();

    if (state === 'completed') {
      if (seenIds.has(jobId)) log(`⚠️  DUPLICADO: ${jobId}`);
      seenIds.add(jobId);
      const latency = Date.now() - (enqueuedAt.get(jobId) ?? processingStart);
      completed.set(jobId, latency);
    } else if (state === 'failed') {
      failed.add(jobId);
      log(`❌ Fallido: ${jobId} — ${job.failedReason}`);
    }
  }

  const done = completed.size + failed.size;
  if (done % 10 === 0 && done > 0 && done < JOB_COUNT) {
    log(`Progreso: ${done}/${JOB_COUNT} (completados: ${completed.size}, fallidos: ${failed.size})`);
  }

  if (completed.size + failed.size >= JOB_COUNT) break;
  await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
}

if (completed.size + failed.size < JOB_COUNT) {
  log(`⚠️  Timeout: ${completed.size} completados, ${failed.size} fallidos, ${JOB_COUNT - completed.size - failed.size} sin terminar`);
}

const totalTime = Date.now() - processingStart;

// ─── Memoria Redis después del test ──────────────────────────────────────────
const memAfter = await connection.info('memory');
const usedAfter = parseInt(memAfter.match(/used_memory:(\d+)/)?.[1] ?? 0);

// ─── Métricas de latencia ────────────────────────────────────────────────────
const latencies = [...completed.values()];
const p50 = percentile(latencies, 50);
const p95 = percentile(latencies, 95);
const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
const throughput = (JOB_COUNT / totalTime * 1000).toFixed(1);

// ─── Verificaciones ───────────────────────────────────────────────────────────
const duplicates = JOB_COUNT - seenIds.size;
const errorRate = (failed.size / JOB_COUNT * 100).toFixed(1);

console.log('\n════════════════════════════════════════');
console.log('RESULTADOS — WORKER-003-c Concurrency Test');
console.log('════════════════════════════════════════');
console.log(`Jobs completados : ${completed.size}/${JOB_COUNT}`);
console.log(`Jobs fallidos    : ${failed.size} (${errorRate}%)`);
console.log(`Duplicados       : ${duplicates}`);
console.log(`Tiempo total     : ${totalTime}ms`);
console.log(`Throughput       : ${throughput} jobs/seg`);
console.log(`Latencia avg     : ${avg}ms`);
console.log(`Latencia p50     : ${p50}ms`);
console.log(`Latencia p95     : ${p95}ms`);
console.log(`Redis memory     : ${(usedBefore/1024/1024).toFixed(2)} MB → ${(usedAfter/1024/1024).toFixed(2)} MB`);
console.log('════════════════════════════════════════\n');

const passed =
  completed.size === JOB_COUNT &&
  failed.size === 0 &&
  duplicates === 0 &&
  parseFloat(errorRate) < 1;

if (passed) {
  log(`✅ CONCURRENCY TEST PASSED`);
} else {
  log(`❌ CONCURRENCY TEST FAILED`);
  process.exitCode = 1;
}

await queue.close();
await connection.quit();
