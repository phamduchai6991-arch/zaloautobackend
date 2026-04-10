import pg from 'pg';
import dns from 'node:dns';

// Render doesn't support IPv6 outbound — force IPv4 for Supabase connection
dns.setDefaultResultOrder('ipv4first');

let pool = null;

function ensurePool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL || '';
  if (!url) throw new Error('Database not configured (DATABASE_URL missing).');
  pool = new pg.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', (err) => console.error('[db] pool error:', err.message));
  return pool;
}

export function getPool() {
  return ensurePool();
}

export async function query(text, params) {
  return ensurePool().query(text, params);
}
