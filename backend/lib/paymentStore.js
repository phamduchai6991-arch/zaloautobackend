import { query } from './db.js';

// ─── Helpers ─────────────────────────────────────────────

function rowToOrder(row) {
  if (!row) return null;
  return {
    code: row.code,
    userId: row.user_id,
    userEmail: row.user_email,
    planKey: row.plan_key,
    period: row.period,
    amount: row.amount,
    status: row.status,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    paidAt: row.paid_at?.toISOString?.() || row.paid_at || null,
    transactionId: row.transaction_id || null,
    source: row.source || null,
  };
}

function rowToSub(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    userEmail: row.user_email,
    planKey: row.plan_key,
    status: row.status,
    startedAt: row.started_at?.toISOString?.() || row.started_at,
    expiresAt: row.expires_at?.toISOString?.() || row.expires_at,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
    lastOrderCode: row.last_order_code || null,
  };
}

let _orderCounter = 0;

function generateOrderCode() {
  const ts = Date.now().toString(36).toUpperCase().slice(-5);
  const rand = Math.random().toString(36).toUpperCase().slice(-1);
  _orderCounter = (_orderCounter + 1) % 100;
  return `AZ${ts}${rand}${_orderCounter.toString().padStart(2, '0')}`;
}

function generateAdminOrderCode() {
  const ts = Date.now().toString(36).toUpperCase().slice(-5);
  const rand = Math.random().toString(36).toUpperCase().slice(-1);
  _orderCounter = (_orderCounter + 1) % 100;
  return `ADM${ts}${rand}${_orderCounter.toString().padStart(2, '0')}`;
}

// ─── Orders ──────────────────────────────────────────────

export async function createOrder({ userId, userEmail, planKey, period, amount }) {
  const code = generateOrderCode();
  const now = new Date().toISOString();

  const result = await query(
    `INSERT INTO orders (code, user_id, user_email, plan_key, period, amount, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
     RETURNING *`,
    [code, userId, userEmail, planKey, period, amount, now],
  );

  return rowToOrder(result.rows[0]);
}

export async function getOrder(code) {
  if (!code) return null;

  // Auto-expire old pending orders
  await query(
    `UPDATE orders SET status = 'expired'
     WHERE code = $1 AND status = 'pending'
       AND created_at < NOW() - INTERVAL '24 hours'`,
    [code],
  );

  const result = await query('SELECT * FROM orders WHERE code = $1', [code]);
  return rowToOrder(result.rows[0]);
}

export async function getOrdersByUser(userId) {
  const result = await query(
    'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
    [userId],
  );
  return result.rows.map(rowToOrder);
}

export async function markOrderPaid(code, transactionId) {
  const now = new Date().toISOString();
  const result = await query(
    `UPDATE orders SET status = 'paid', paid_at = $2, transaction_id = $3
     WHERE code = $1 AND status IN ('pending', 'expired')
     RETURNING *`,
    [code, now, transactionId],
  );
  return rowToOrder(result.rows[0]);
}

export async function findPendingOrderByCode(transferContent, { includeRecentExpiredHours = 72 } = {}) {
  const normalized = (transferContent || '').toUpperCase().replace(/\s+/g, '');
  if (!normalized) return null;

  const safeHours = Math.max(1, Math.min(24 * 30, Number(includeRecentExpiredHours) || 72));

  const result = await query(
    `SELECT *
       FROM orders
      WHERE status = 'pending'
         OR (status = 'expired' AND created_at >= NOW() - ($1 || ' hours')::INTERVAL)
      ORDER BY created_at DESC`,
    [String(safeHours)],
  );

  for (const row of result.rows) {
    if (normalized.includes(row.code.toUpperCase())) return rowToOrder(row);
  }
  return null;
}

export async function cancelExpiredOrders(maxAgeMs = 24 * 60 * 60 * 1000) {
  const intervalSec = Math.floor(maxAgeMs / 1000);
  const result = await query(
    `UPDATE orders SET status = 'expired'
     WHERE status = 'pending'
       AND created_at < NOW() - ($1 || ' seconds')::INTERVAL
     RETURNING code`,
    [String(intervalSec)],
  );
  return result.rowCount;
}

export async function expireElapsedSubscriptions() {
  const result = await query(
    `UPDATE subscriptions
        SET status = 'expired', updated_at = NOW()
      WHERE status = 'active'
        AND expires_at < NOW()
      RETURNING user_id`,
  );
  return result.rowCount;
}

// ─── Subscriptions ───────────────────────────────────────

const PLAN_DURATION = {
  monthly: 30,
  yearly: 365,
};

export async function activateSubscription(order) {
  const days = PLAN_DURATION[order.period] || 30;
  const newExpiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  // Check existing active subscription
  const existingResult = await query(
    `SELECT * FROM subscriptions WHERE user_id = $1`,
    [order.userId],
  );
  const existing = rowToSub(existingResult.rows[0]);

  if (existing && existing.status === 'active' && new Date(existing.expiresAt) > new Date()) {
    const tierRank = { basic: 1, plus: 2, pro: 3 };
    const newRank = tierRank[order.planKey] ?? 0;
    const oldRank = tierRank[existing.planKey] ?? 0;

    if (newRank > oldRank) {
      // Upgrade: start fresh period
      const result = await query(
        `UPDATE subscriptions SET plan_key = $2, started_at = $3, expires_at = $4, updated_at = $3, last_order_code = $5
         WHERE user_id = $1 RETURNING *`,
        [order.userId, order.planKey, now, newExpiresAt, order.code],
      );
      return rowToSub(result.rows[0]);
    } else if (newRank === oldRank) {
      // Same plan renewal: stack time
      const currentEnd = new Date(existing.expiresAt);
      const stackedExpiry = new Date(currentEnd.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
      const result = await query(
        `UPDATE subscriptions SET plan_key = $2, expires_at = $3, updated_at = $4, last_order_code = $5
         WHERE user_id = $1 RETURNING *`,
        [order.userId, order.planKey, stackedExpiry, now, order.code],
      );
      return rowToSub(result.rows[0]);
    } else {
      // Downgrade: stack time, keep higher tier
      const currentEnd = new Date(existing.expiresAt);
      const stackedExpiry = new Date(currentEnd.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
      const result = await query(
        `UPDATE subscriptions SET expires_at = $2, updated_at = $3, last_order_code = $4
         WHERE user_id = $1 RETURNING *`,
        [order.userId, stackedExpiry, now, order.code],
      );
      return rowToSub(result.rows[0]);
    }
  }

  // No active subscription — insert or upsert
  const result = await query(
    `INSERT INTO subscriptions (user_id, user_email, plan_key, status, started_at, expires_at, updated_at, last_order_code)
     VALUES ($1, $2, $3, 'active', $4, $5, $4, $6)
     ON CONFLICT (user_id) DO UPDATE SET
       user_email = $2, plan_key = $3, status = 'active',
       started_at = $4, expires_at = $5, updated_at = $4, last_order_code = $6
     RETURNING *`,
    [order.userId, order.userEmail, order.planKey, now, newExpiresAt, order.code],
  );
  return rowToSub(result.rows[0]);
}

export async function getSubscription(userId, userEmail = '') {
  let result = await query('SELECT * FROM subscriptions WHERE user_id = $1', [userId]);
  let sub = rowToSub(result.rows[0]);

  // Fallback: lookup by email if not found by userId
  if (!sub && userEmail) {
    const normalizedEmail = String(userEmail).trim().toLowerCase();
    const emailResult = await query(
      'SELECT * FROM subscriptions WHERE LOWER(TRIM(user_email)) = $1',
      [normalizedEmail],
    );
    if (emailResult.rows[0]) {
      const legacyRow = emailResult.rows[0];
      // Migrate to new userId
      await query(
        `UPDATE subscriptions SET user_id = $1, updated_at = NOW() WHERE user_id = $2`,
        [userId, legacyRow.user_id],
      );
      result = await query('SELECT * FROM subscriptions WHERE user_id = $1', [userId]);
      sub = rowToSub(result.rows[0]);
    }
  }

  if (!sub) return null;

  // Auto-expire
  if (sub.status === 'active' && new Date(sub.expiresAt) < new Date()) {
    await query(
      `UPDATE subscriptions SET status = 'expired' WHERE user_id = $1`,
      [userId],
    );
    sub.status = 'expired';
  }

  return sub;
}

export async function getAllSubscriptions() {
  await expireElapsedSubscriptions();
  const result = await query('SELECT * FROM subscriptions ORDER BY updated_at DESC');
  return result.rows.map(rowToSub);
}

export async function getAllOrders() {
  const result = await query('SELECT * FROM orders ORDER BY created_at DESC');
  return result.rows.map(rowToOrder);
}

export async function grantAdminSubscription({ userId, userEmail, planKey, period, adminUsername = 'admin' }) {
  const now = new Date().toISOString();
  const code = generateAdminOrderCode();

  await query(
    `INSERT INTO orders (code, user_id, user_email, plan_key, period, amount, status, created_at, paid_at, transaction_id, source)
     VALUES ($1, $2, $3, $4, $5, 0, 'paid', $6, $6, $7, 'admin')`,
    [code, userId, userEmail, planKey, period, now, `admin:${adminUsername}`],
  );

  const order = await getOrder(code);
  const subscription = await activateSubscription(order);
  return { order, subscription };
}
