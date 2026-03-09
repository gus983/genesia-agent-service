/**
 * migrate-honorarios-remove-phrase.js
 *
 * Removes the phrase "Son abonados por Genesia directamente a vos,
 * independientemente de lo que pague la paciente." from honorarios KB items.
 *
 * Run once on VPS:
 *   DATABASE_URL=... node scripts/migrate-honorarios-remove-phrase.js
 */

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const PHRASE = /Son abonados por Genesia directamente a vos, independientemente de lo que pague la paciente\.?\s*\n?/g;

async function run() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT key, data->>'text' AS text
       FROM knowledge_items
       WHERE domain = 'nipt' AND kind = 'pricing'
         AND key LIKE 'honorarios_%'
         AND data->>'text' LIKE '%Son abonados%'`
    );

    if (!rows.length) {
      console.log('Nothing to update — phrase not found in any honorarios item.');
      return;
    }

    for (const row of rows) {
      const newText = row.text.replace(PHRASE, '');
      await client.query(
        `UPDATE knowledge_items
         SET data = jsonb_set(data, '{text}', to_jsonb($2::text)), updated_at = now()
         WHERE domain = 'nipt' AND kind = 'pricing' AND key = $1`,
        [row.key, newText]
      );
      console.log(`Updated ${row.key} — removed phrase.`);
    }

    console.log('Done.');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(e => { console.error(e.message); process.exit(1); });
