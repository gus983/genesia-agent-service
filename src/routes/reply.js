import express from 'express';
import { getPool } from '../db/index.js';

export function replyRouter() {
  const r = express.Router();

  // MVP contract:
  // POST /reply { wa_id, text, country? }
  r.post('/', async (req, res) => {
    const { wa_id, text, country } = req.body || {};
    if (!wa_id) return res.status(400).json({ ok: false, error: 'missing_wa_id' });

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Upsert contact
      await client.query(
        `INSERT INTO contacts (wa_id, country, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (wa_id) DO UPDATE SET country = COALESCE(EXCLUDED.country, contacts.country), updated_at = now()`,
        [wa_id, country || null]
      );

      // Log inbound message
      await client.query(
        `INSERT INTO messages (wa_id, direction, text, meta) VALUES ($1,'in',$2,$3)`,
        [wa_id, String(text || ''), { source: 'wa-bridge' }]
      );

      await client.query('COMMIT');

      // Stub reply for now
      return res.json({
        ok: true,
        reply: 'Recibido. (MVP) En breve integramos KB/RAG + políticas + follow-ups.',
        action: { kind: 'text' }
      });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('reply failed:', e?.message || e);
      return res.status(500).json({ ok: false, error: 'reply_failed' });
    } finally {
      client.release();
      await pool.end();
    }
  });

  return r;
}
