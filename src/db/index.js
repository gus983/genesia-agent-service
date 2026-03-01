import pg from 'pg';

const { Pool } = pg;

export function getPool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Missing env: DATABASE_URL');
  return new Pool({ connectionString: url });
}
