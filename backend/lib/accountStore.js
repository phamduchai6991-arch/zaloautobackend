import { query } from './db.js';

const PLAN_LIMITS = { basic: 1, plus: 3, pro: 10 };
let schemaReadyPromise = null;

async function ensureAccountSchema() {
  if (schemaReadyPromise) return schemaReadyPromise;

  schemaReadyPromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS zalo_accounts (
        user_id TEXT NOT NULL,
        zalo_id TEXT NOT NULL,
        zalo_name TEXT DEFAULT '',
        zalo_avatar TEXT DEFAULT '',
        zalo_phone TEXT DEFAULT '',
        added_at TIMESTAMPTZ DEFAULT now(),
        last_used_at TIMESTAMPTZ DEFAULT now(),
        session_blob JSONB DEFAULT '{}'::jsonb,
        sync_status TEXT DEFAULT 'idle',
        synced_at TIMESTAMPTZ NULL,
        service_synced_at TIMESTAMPTZ NULL,
        PRIMARY KEY (user_id, zalo_id)
      )
    `);

    await query(`ALTER TABLE zalo_accounts ADD COLUMN IF NOT EXISTS session_blob JSONB DEFAULT '{}'::jsonb`);
    await query(`ALTER TABLE zalo_accounts ADD COLUMN IF NOT EXISTS sync_status TEXT DEFAULT 'idle'`);
    await query(`ALTER TABLE zalo_accounts ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ NULL`);
    await query(`ALTER TABLE zalo_accounts ADD COLUMN IF NOT EXISTS service_synced_at TIMESTAMPTZ NULL`);
  })().catch((error) => {
    schemaReadyPromise = null;
    throw error;
  });

  return schemaReadyPromise;
}

// ─── Helpers ─────────────────────────────────────────────

function rowToAccount(row) {
  if (!row) return null;
  const session = row.session_blob && typeof row.session_blob === 'object' ? row.session_blob : {};
  return {
    ...session,
    id: session.id || row.zalo_id,
    ownerUserId: row.user_id,
    userId: session.userId || row.zalo_id,
    zaloId: row.zalo_id,
    name: session.name || session.displayName || row.zalo_name,
    avatar: session.avatar || row.zalo_avatar,
    phone: session.phone || session.phoneNumber || row.zalo_phone,
    zaloName: row.zalo_name,
    zaloAvatar: row.zalo_avatar,
    zaloPhone: row.zalo_phone,
    addedAt: row.added_at?.toISOString?.() || row.added_at,
    lastUsedAt: row.last_used_at?.toISOString?.() || row.last_used_at,
    syncStatus: session.syncStatus || row.sync_status || 'idle',
    syncedAt: session.syncedAt || row.synced_at?.toISOString?.() || row.synced_at || null,
    serviceSyncedAt: session.serviceSyncedAt || row.service_synced_at?.toISOString?.() || row.service_synced_at || null,
  };
}

// ─── Queries ─────────────────────────────────────────────

export async function getAccountsByUser(userId) {
  await ensureAccountSchema();
  const result = await query(
    'SELECT * FROM zalo_accounts WHERE user_id = $1 ORDER BY added_at',
    [userId],
  );
  return result.rows.map(rowToAccount);
}

export async function countAccountsByUser(userId) {
  await ensureAccountSchema();
  const result = await query(
    'SELECT COUNT(*)::int AS cnt FROM zalo_accounts WHERE user_id = $1',
    [userId],
  );
  return result.rows[0]?.cnt || 0;
}

/**
 * Register a Zalo account for a user.
 * Returns { ok, account?, error? }
 */
export async function registerAccount({ userId, planKey, zaloId, zaloName, zaloAvatar, zaloPhone, accountData = null }) {
  await ensureAccountSchema();
  const limit = PLAN_LIMITS[planKey] ?? PLAN_LIMITS.basic;
  const accountBlob = accountData ? JSON.stringify(accountData) : null;
  const syncStatus = accountData?.syncStatus || null;
  const syncedAt = accountData?.syncedAt || null;
  const serviceSyncedAt = accountData?.serviceSyncedAt || null;

  // Check if this zalo account is already registered for this user
  const existing = await query(
    'SELECT * FROM zalo_accounts WHERE user_id = $1 AND zalo_id = $2',
    [userId, zaloId],
  );

  if (existing.rows.length > 0) {
    // Already registered — update info and last_used_at
    const result = await query(
      `UPDATE zalo_accounts SET zalo_name = $3, zalo_avatar = $4, zalo_phone = $5, last_used_at = now(),
         session_blob = COALESCE($6::jsonb, session_blob),
         sync_status = COALESCE($7, sync_status),
         synced_at = COALESCE($8::timestamptz, synced_at),
         service_synced_at = COALESCE($9::timestamptz, service_synced_at)
       WHERE user_id = $1 AND zalo_id = $2
       RETURNING *`,
      [userId, zaloId, zaloName || '', zaloAvatar || '', zaloPhone || '', accountBlob, syncStatus, syncedAt, serviceSyncedAt],
    );
    return { ok: true, account: rowToAccount(result.rows[0]), existing: true };
  }

  // Check limit
  const count = await countAccountsByUser(userId);
  if (count >= limit) {
    return {
      ok: false,
      error: `Gói ${planKey?.toUpperCase() || 'BASIC'} chỉ cho phép tối đa ${limit} tài khoản. Bạn đã dùng ${count}/${limit}.`,
      count,
      limit,
    };
  }

  // Insert new
  const result = await query(
    `INSERT INTO zalo_accounts (user_id, zalo_id, zalo_name, zalo_avatar, zalo_phone, session_blob, sync_status, synced_at, service_synced_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::jsonb, '{}'::jsonb), COALESCE($7, 'idle'), $8::timestamptz, $9::timestamptz)
     RETURNING *`,
    [userId, zaloId, zaloName || '', zaloAvatar || '', zaloPhone || '', accountBlob, syncStatus, syncedAt, serviceSyncedAt],
  );

  return { ok: true, account: rowToAccount(result.rows[0]), existing: false };
}

export async function removeAccount(userId, zaloId) {
  await ensureAccountSchema();
  const result = await query(
    'DELETE FROM zalo_accounts WHERE user_id = $1 AND zalo_id = $2 RETURNING *',
    [userId, zaloId],
  );
  return result.rowCount > 0;
}

export async function getAccount(userId, zaloId) {
  await ensureAccountSchema();
  const result = await query(
    'SELECT * FROM zalo_accounts WHERE user_id = $1 AND zalo_id = $2',
    [userId, zaloId],
  );
  return result.rows.length > 0 ? rowToAccount(result.rows[0]) : null;
}

export async function touchAccount(userId, zaloId) {
  await ensureAccountSchema();
  await query(
    'UPDATE zalo_accounts SET last_used_at = now() WHERE user_id = $1 AND zalo_id = $2',
    [userId, zaloId],
  );
}

export { PLAN_LIMITS };
