/**
 * errors.mjs — Clasificación de errores para retry logic
 * Data Laundering V2.0 — TASK-27 / QUEUE-002-b
 *
 * RetryableError  → BullMQ reintenta automáticamente (backoff exponencial)
 * TerminalError   → Sin retry. Job va directo a failed/dead.
 */

import { UnrecoverableError } from 'bullmq';

/**
 * Errores transitorios — BullMQ reintentará con backoff exponencial (2s, 4s, 8s)
 *
 * Casos: timeout OCR, rate limit IA (HTTP 429), ECONNRESET,
 *        servicio externo no disponible (502/503/504), Redis timeout
 */
export class RetryableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'RetryableError';
    this.cause = cause;
  }
}

/**
 * Errores permanentes — Sin retry. Lanza UnrecoverableError de BullMQ.
 *
 * Casos: PDF corrupto, organization_id no encontrado, archivo 404 en Storage,
 *        payload inválido, tenant sin créditos (cuando se implemente billing)
 */
export class TerminalError extends Error {
  constructor(message, { cause, code } = {}) {
    super(message);
    this.name = 'TerminalError';
    this.cause = cause ?? null;
    this.code = code ?? null;
  }
}

/**
 * Clasifica un error HTTP de servicios externos.
 * Devuelve RetryableError o TerminalError según el código de estado.
 */
export function classifyHttpError(status, message) {
  const retryable = [408, 425, 429, 500, 502, 503, 504];
  if (retryable.includes(status)) {
    return new RetryableError(`HTTP ${status}: ${message}`);
  }
  return new TerminalError(`HTTP ${status} (no retryable): ${message}`);
}

/**
 * Envuelve un TerminalError en UnrecoverableError de BullMQ
 * para que el job no genere más intentos.
 */
export function toUnrecoverable(err) {
  return new UnrecoverableError(err.message);
}
