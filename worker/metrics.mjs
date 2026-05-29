/**
 * metrics.mjs — Métricas y observabilidad de la cola
 * Data Laundering V2.0 — TASK-29 / QUEUE-002-d
 *
 * Expone un endpoint HTTP GET /metrics con métricas JSON de la cola.
 * Puerto: METRICS_PORT (default: 9090)
 *
 * Ejemplo de respuesta:
 *   GET http://localhost:9090/metrics
 */

import { createServer } from 'http';

const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9090);

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Recopila métricas actuales de la cola BullMQ.
 * Seguro para llamar en cualquier momento — no modifica estado.
 */
export async function collectQueueMetrics(queue) {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);

  // Latencias de los últimos 100 jobs completados
  const recentJobs = await queue.getCompleted(0, 99);
  const latencies = recentJobs
    .filter(j => j.processedOn && j.finishedOn)
    .map(j => j.finishedOn - j.timestamp);

  const total = completed + failed;
  const errorRate = total > 0 ? Math.round(failed / total * 100) : 0;

  return {
    timestamp: new Date().toISOString(),
    worker_version: process.env.WORKER_VERSION ?? 'unknown',
    queue_name: queue.name,
    queue_depth: {
      waiting,
      active,
      delayed,
    },
    totals: {
      completed,
      failed,
    },
    latency_ms: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      avg: latencies.length
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : null,
      sample_size: latencies.length,
    },
    error_rate_pct: errorRate,
  };
}

/**
 * Inicia el servidor HTTP de métricas.
 * @param {Queue} queue — instancia BullMQ
 * @param {Function} log — función de logging estructurado
 */
export function startMetricsServer(queue, log) {
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', worker_version: process.env.WORKER_VERSION }));
      return;
    }

    if (req.url === '/metrics') {
      try {
        const metrics = await collectQueueMetrics(queue);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(metrics, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end('Not Found — endpoints: /metrics /health');
  });

  server.listen(METRICS_PORT, () => {
    log('info', 'metrics.server_started', {
      port: METRICS_PORT,
      endpoints: ['/metrics', '/health'],
    });
  });

  server.on('error', (err) => {
    log('error', 'metrics.server_error', { message: err.message });
  });

  return server;
}
