/**
 * bull-board.mjs — Dashboard visual de la cola BullMQ
 * Data Laundering V2.0
 *
 * UI con estado en tiempo real de la cola: waiting, active, failed, DLQ.
 * Protegido con HTTP Basic Auth (BULL_BOARD_USER / BULL_BOARD_PASSWORD).
 *
 * Acceso via SSH tunnel (no expuesto públicamente):
 *   ssh -L 9091:localhost:9091 root@157.230.231.207
 *   → abrir http://localhost:9091
 *
 * Puerto: BULL_BOARD_PORT (default: 9091)
 */

import express from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import basicAuth from 'express-basic-auth';

const BULL_BOARD_PORT = Number(process.env.BULL_BOARD_PORT ?? 9091);
const BULL_BOARD_USER = process.env.BULL_BOARD_USER ?? 'admin';
const BULL_BOARD_PASSWORD = process.env.BULL_BOARD_PASSWORD ?? 'dl-monitor-2026';

/**
 * Inicia el servidor de Bull Board.
 * @param {Queue} queue — instancia BullMQ (la misma que usa el worker)
 * @param {Function} log — función de logging estructurado
 */
export function startBullBoard(queue, log) {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/');

  createBullBoard({
    queues: [new BullMQAdapter(queue)],
    serverAdapter,
  });

  const app = express();

  // ── Basic Auth ────────────────────────────────────────────────────────────
  app.use(basicAuth({
    users: { [BULL_BOARD_USER]: BULL_BOARD_PASSWORD },
    challenge: true,
    realm: 'Data Laundering Monitor',
  }));

  app.use('/', serverAdapter.getRouter());

  const server = app.listen(BULL_BOARD_PORT, '127.0.0.1', () => {
    log('info', 'bullboard.started', {
      port: BULL_BOARD_PORT,
      user: BULL_BOARD_USER,
      note: 'ssh -L 9091:localhost:9091 root@157.230.231.207 → http://localhost:9091',
    });
  });

  server.on('error', (err) => {
    log('error', 'bullboard.error', { message: err.message });
  });

  return server;
}
