/**
 * INFRA-001-b — Verificar conexión BullMQ a Redis Cloud
 *
 * Uso:
 *   node infra-001b-verify-bullmq.mjs
 *
 * Variables de entorno requeridas (.env.staging):
 *   REDIS_HOST=redis-16705.crce216.sa-east-1-2.ec2.cloud.redislabs.com
 *   REDIS_PORT=16705
 *   REDIS_PASSWORD=<tu_password>
 *   REDIS_TLS=true
 */

import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const host = process.env.REDIS_HOST;
const port = Number(process.env.REDIS_PORT || 16705);
const password = process.env.REDIS_PASSWORD;
const useTLS = process.env.REDIS_TLS === 'true';

if (!host || !password) {
  console.error('❌ Faltan variables de entorno: REDIS_HOST y REDIS_PASSWORD son requeridas.');
  process.exit(1);
}

console.log(`🔌 Conectando a Redis Cloud...`);
console.log(`   Host: ${host}:${port}`);
console.log(`   TLS: ${useTLS}`);

// ioredis connection — requerida por BullMQ
const connection = new IORedis({
  host,
  port,
  password,
  tls: useTLS ? {} : undefined,
  maxRetriesPerRequest: null, // REQUERIDO por BullMQ
  enableReadyCheck: false,
});

connection.on('connect', () => console.log('✅ ioredis: conectado'));
connection.on('error', (err) => console.error('❌ ioredis error:', err.message));

try {
  // Verificar ping directo
  const pong = await connection.ping();
  console.log(`✅ PING → ${pong}`);

  // Conectar BullMQ Queue
  const queue = new Queue('pdf-processing', { connection });

  // Verificar job counts
  const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
  console.log('✅ BullMQ Queue conectada — job counts:', counts);

  // Limpiar
  await queue.close();
  await connection.quit();

  console.log('\n✅ INFRA-001-b VERIFICADO — BullMQ conecta a Redis Cloud correctamente.');
  process.exit(0);
} catch (err) {
  console.error('\n❌ Error de conexión:', err.message);
  console.error('\nVerificar:');
  console.error('  1. REDIS_PASSWORD correcto');
  console.error('  2. REDIS_TLS=true (Redis Cloud requiere TLS)');
  console.error('  3. IP del servidor en whitelist de Redis Cloud');
  process.exit(1);
}
