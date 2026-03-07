import { getPool } from './index.js';

// Each step runs in its own transaction so a new migration doesn't roll back
// previously applied ones. All statements are additive and idempotent.

const STEPS = [
  {
    name: 'M1_create_tables',
    sql: `
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
  ON knowledge_items (domain, kind, market, key);
`,
  },
  {
    name: 'M2_knowledge_items_coalesce_index',
    sql: `
ALTER TABLE knowledge_items
  DROP CONSTRAINT IF EXISTS knowledge_items_domain_kind_market_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_knowledge_items_coalesce
  ON knowledge_items (domain, kind, COALESCE(market, '__GLOBAL__'), key);
`,
  },
  {
    name: 'M3_contacts_email',
    sql: `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email TEXT;`,
  },
];

// Columns that must exist after all migrations. Missing any → startup fails.
const REQUIRED_COLUMNS = [
  { table: 'contacts', column: 'email' },
  { table: 'contacts', column: 'verified_doctor' },
  { table: 'knowledge_items', column: 'data' },
];

async function runStep(client, { name, sql }) {
  console.log(`[migrate] running ${name} ...`);
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('COMMIT');
    console.log(`[migrate] ${name} OK`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`[migrate] ${name} FAILED: ${e.message}`);
    throw e;
  }
}

async function verifySchema(client) {
  for (const { table, column } of REQUIRED_COLUMNS) {
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column]
    );
    if (!rows.length) {
      throw new Error(`[migrate] schema check FAILED: ${table}.${column} is missing`);
    }
  }
  console.log('[migrate] schema verification OK');
}

export async function migrate() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    for (const step of STEPS) {
      await runStep(client, step);
    }
    await verifySchema(client);
  } finally {
    client.release();
    await pool.end();
  }
}
