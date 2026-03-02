import { getPool } from './index.js';

// Aditive, idempotent migrations only (MVP)
const SQL = `
CREATE TABLE IF NOT EXISTS contacts (
  id BIGSERIAL PRIMARY KEY,
  wa_id TEXT UNIQUE NOT NULL,
  country TEXT,
  contact_type TEXT DEFAULT 'unknown',
  verified_doctor BOOLEAN DEFAULT FALSE,
  verification_source TEXT,
  verification_confidence REAL,
  name TEXT,
  institution TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  wa_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  text TEXT,
  meta JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contact_state (
  wa_id TEXT PRIMARY KEY,
  stage TEXT,
  objections JSONB,
  product_interest TEXT,
  next_step TEXT,
  next_touch_due_at TIMESTAMPTZ,
  summary TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_items (
  id BIGSERIAL PRIMARY KEY,
  domain TEXT NOT NULL,
  kind TEXT NOT NULL,
  market TEXT,
  key TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (domain, kind, market, key)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_items_lookup
  ON knowledge_items (domain, kind, market, key)
`;

export async function migrate() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(SQL);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}
