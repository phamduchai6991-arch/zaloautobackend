import pg from 'pg';
import dns from 'node:dns';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

dns.setDefaultResultOrder('ipv4first');

// Load .env
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', 'backend', '.env');
for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq > 0) {
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
console.log('Connected');

await client.query(`
  CREATE TABLE IF NOT EXISTS zalo_accounts (
    user_id    TEXT NOT NULL,
    zalo_id    TEXT NOT NULL,
    zalo_name  TEXT NOT NULL DEFAULT '',
    zalo_avatar TEXT NOT NULL DEFAULT '',
    zalo_phone TEXT NOT NULL DEFAULT '',
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, zalo_id)
  );
  CREATE INDEX IF NOT EXISTS idx_zalo_accounts_user ON zalo_accounts(user_id);
`);

console.log('Table zalo_accounts created');

const cols = await client.query(
  "SELECT column_name FROM information_schema.columns WHERE table_name='zalo_accounts' ORDER BY ordinal_position"
);
console.log('Columns:', cols.rows.map(r => r.column_name).join(', '));

await client.end();
