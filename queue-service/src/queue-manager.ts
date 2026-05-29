/**
 * queue-manager.ts — Única interfaz del sistema para interactuar con BullMQ
 * Data Laundering V2.0 — QUEUE-002-a
 *
 * REGLAS:
 * - Toda interacción con Redis debe pasar por este módulo
 * - enqueueJob() es idempotente: mismo job_id no duplica el job
 * - getJobStatus() nunca lanza excepción (devuelve null si no existe)
 */

import { Queue } from 'bullmq';
import { redisConnection } from './connection.js';
import type { QueueJob, JobStatusResult } from './types.js';

const QUEUE_NAME = 'pdf-processing';

export const queue = new Queue(QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000, // 2s, 4s, 8s
    },
    removeOnComplete: {
      age: 604800, // 7 días en segundos
      count: 1000,
    },
    removeOnFail: false, // mantener jobs fallidos para inspección
  },
});

/**
 * Encola un job de procesamiento de PDF.
 * Idempotente: si ya existe un job con ese job_id, devuelve el ID existente.
 */
export async function enqueueJob(payload: QueueJob): Promise<string> {
  const job = await queue.add('process-pdf', payload, {
    jobId: payload.job_id, // garantiza idempotencia
    priority: payload.priority ?? 5,
  });
  return job.id!;
}

/**
 * Consulta el estado de un job por su ID.
 * Devuelve null si el job no existe (fue removido o nunca existió).
 */
export async function getJobStatus(jobId: string): Promise<JobStatusResult | null> {
  const job = await queue.getJob(jobId);
  if (!job) return null;

  const state = await job.getState();
  return {
    id: job.id!,
    status: state,
    attempts: job.attemptsMade,
    failed_reason: job.failedReason ?? undefined,
  };
}

/**
 * Cierra la conexión con Redis limpiamente.
 * Llamar al apagar el proceso.
 */
export async function closeQueue(): Promise<void> {
  await queue.close();
}
