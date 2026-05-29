/**
 * connection.ts — Conexión ioredis a Redis Cloud
 * Data Laundering V2.0 — INFRA-001-b
 *
 * IMPORTANTE: Puerto 16705 de Redis Cloud no requiere TLS desde el servidor DO.
 * Si se migra a otro host o puerto con TLS, agregar: tls: {}
 */

import IORedis from 'ioredis';

const host = process.env.REDIS_HOST;
const port = Number(process.env.REDIS_PORT ?? 16705);
const password = process.env.REDIS_PASSWORD;

if (!host || !password) {
  throw new Error(
    'REDIS_HOST y REDIS_PASSWORD son requeridas. ' +
    'Configurar en .env.staging o variables de entorno del servidor.'
  );
}

export const redisConnection = new IORedis({
  host,
  port,
  password,
  maxRetriesPerRequest: null, // REQUERIDO por BullMQ
  enableReadyCheck: false,
  lazyConnect: false,
});

redisConnection.on('error', (err) => {
  console.error('[Redis] Error de conexión:', err.message);
});
