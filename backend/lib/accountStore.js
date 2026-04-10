import { query } from './db.js';

const PLAN_LIMITS = { basic: 1, plus: 3, pro: 10 };

// ─── Helpers ─────────────────────────────────────────────

function rowToAccount(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    zaloId: row.zalo_id,
    zaloName: row.zalo_name,
    zaloAvatar: row.zalo_avatar,
    zaloPhone: row.zalo_phone,
    addedAt: row.added_at?.toISOString?.() || row.added_at,
    lastUsedAt: row.last_used_at?.toISOString?.() || row.last_used_at,
  };
}

// ─── Queries ─────────────────────────────────────────────

export async function getAccountsByUser(userId) {
  const result = await query(
    'SELECT * FROM zalo_accounts WHERE user_id = $1 ORDER BY added_at',
    [userId],
  );
  return result.rows.map(rowToAccount);
}

export async function countAccountsByUser(userId) {
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
export async function registerAccount({ userId, planKey, zaloId, zaloName, zaloAvatar, zaloPhone }) {
  const limit = PLAN_LIMITS[planKey] ?? PLAN_LIMITS.basic;

  // Check if this zalo account is already registered for this user
  const existing = await query(
    'SELECT * FROM zalo_accounts WHERE user_id = $1 AND zalo_id = $2',
    [userId, zaloId],
  );

  if (existing.rows.length > 0) {
    // Already registered — update info and last_used_at
    const result = await query(
      `UPDATE zalo_accounts SET zalo_name = $3, zalo_avatar = $4, zalo_phone = $5, last_used_at = now()
       WHERE user_id = $1 AND zalo_id = $2
       RETURNING *`,
      [userId, zaloId, zaloName || '', zaloAvatar || '', zaloPhone || ''],
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
    `INSERT INTO zalo_accounts (user_id, zalo_id, zalo_name, zalo_avatar, zalo_phone)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, zaloId, zaloName || '', zaloAvatar || '', zaloPhone || ''],
  );

  return { ok: true, account: rowToAccount(result.rows[0]), existing: false };
}

export async function removeAccount(userId, zaloId) {
  const result = await query(
    'DELETE FROM zalo_accounts WHERE user_id = $1 AND zalo_id = $2 RETURNING *',
    [userId, zaloId],
  );
  return result.rowCount > 0;
}

export async function touchAccount(userId, zaloId) {
  await query(
    'UPDATE zalo_accounts SET last_used_at = now() WHERE user_id = $1 AND zalo_id = $2',
    [userId, zaloId],
  );
}

export { PLAN_LIMITS };
