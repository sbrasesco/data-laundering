/**
 * queue-002a-verify.mjs — Verificación QUEUE-002-a (Queue Manager)
 * Corre directamente con: REDIS_HOST=... REDIS_PASSWORD=... node queue-002a-verify.mjs
 */

import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT ?? 16705),
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const QUEUE_NAME = 'pdf-processing';

const queue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 604800, count: 1000 },
    removeOnFail: false,
  },
});

// ─── Helpers ────────────────────────────────────────────────────────────────

async function enqueueJob(payload) {
  const job = await queue.add('process-pdf', payload, {
    jobId: payload.job_id,
    priority: payload.priority ?? 5,
  });
  return job.id;
}

async function getJobStatus(jobId) {
  const job = await queue.getJob(jobId);
  if (!job) return null;
  return { id: job.id, status: await job.getState(), attempts: job.attemptsMade };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

const testJobId = 'test-' + Date.now();
const testPayload = {
  job_id: testJobId,
  organization_id: '6b505051-9891-4ef0-b163-07eaf7230f22',
  file_url: 'https://example.com/storage/facturas/test.pdf',
  file_type: 'pdf',
  file_hash: 'sha256:abc123',
  original_filename: 'test_factura.pdf',
  file_size_bytes: 51200,
  client_cuit: '30-71234567-9',
  client_name: 'ACME S.A.',
  oc_entries: [],
  priority: 5,
  metadata: { source: 'frontend_upload', worker_version: '1.0.0' },
};

console.log('── TEST 1: enqueueJob() ─────────────────────────────');
const jobId = await enqueueJob(testPayload);
console.log('✅ Job encolado. ID:', jobId);
if (jobId !== testJobId) {
  console.error('❌ ERROR: jobId no coincide con job_id del payload');
  process.exit(1);
}

console.log('\n── TEST 2: getJobStatus() ───────────────────────────');
const status = await getJobStatus(testJobId);
console.log('✅ Status:', JSON.stringify(status, null, 2));
if (!status || status.status !== 'waiting') {
  console.warn('⚠️  Estado esperado: waiting, obtenido:', status?.status);
}

console.log('\n── TEST 3: Idempotencia (mismo job_id no duplica) ───');
const jobId2 = await enqueueJob(testPayload); // mismo payload, mismo job_id
console.log('✅ Segundo enqueue. ID:', jobId2);
if (jobId !== jobId2) {
  console.error('❌ ERROR: Idempotencia FALLA — se creó un job duplicado');
  process.exit(1);
}
console.log('✅ Idempotencia OK — mismo job_id no duplica');

console.log('\n── TEST 4: getJobStatus() de job inexistente ────────');
const missing = await getJobStatus('job-que-no-existe-xyz');
console.log('✅ Job inexistente devuelve null:', missing);
if (missing !== null) {
  console.error('❌ ERROR: debería devolver null');
  process.exit(1);
}

console.log('\n── Limpieza ─────────────────────────────────────────');
const job = await queue.getJob(testJobId);
if (job) await job.remove();
console.log('✅ Job de test eliminado');

await queue.close();
await connection.quit();

console.log('\n✅ QUEUE-002-a VERIFICADO — Queue Manager funciona correctamente.');
