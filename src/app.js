import express from 'express';
import { replyRouter } from './routes/reply.js';
import { simRouter } from './routes/sim.js';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'genesia-agent-service', time: new Date().toISOString() }));

  app.use('/reply', replyRouter());
  app.use('/sim', simRouter());

  app.use((_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('Unhandled error:', err?.message || err);
    res.status(500).json({ ok: false, error: 'internal_error' });
  });

  return app;
}
