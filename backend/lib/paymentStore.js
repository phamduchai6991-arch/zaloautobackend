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
    source: row.source || undefined,
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
  const result = await query('SELECT * FROM orders WHERE code = $1', [code]);
  const order = rowToOrder(result.rows[0]);
  if (!order) return null;

  // Auto-expire pending orders older than 24h
  if (order.status === 'pending' && Date.now() - new Date(order.createdAt).getTime() > 24 * 60 * 60 * 1000) {
    await query("UPDATE orders SET status = 'expired' WHERE code = $1 AND status = 'pending'", [code]);
    order.status = 'expired';
  }

  return order;
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
     WHERE code = $1 AND status = 'pending'
     RETURNING *`,
    [code, now, transactionId],
  );
  return rowToOrder(result.rows[0]);
}

export async function findPendingOrderByCode(transferContent) {
  const normalized = (transferContent || '').toUpperCase().replace(/\s+/g, '');
  const result = await query("SELECT * FROM orders WHERE status = 'pending'");

  for (const row of result.rows) {
    if (normalized.includes(row.code.toUpperCase())) {
      return rowToOrder(row);
    }
  }
  return null;
}

export async function cancelExpiredOrders(maxAgeMs = 24 * 60 * 60 * 1000) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const result = await query(
    `UPDATE orders SET status = 'expired'
     WHERE status = 'pending' AND created_at < $1`,
    [cutoff],
  );
  return result.rowCount || 0;
}

// ─── Subscriptions ───────────────────────────────────────

const PLAN_DURATION = {
  monthly: 30,
  yearly: 365,
};

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export async function activateSubscription(order) {
  const days = PLAN_DURATION[order.period] || 30;
  const now = new Date();
  const tierRank = { basic: 1, plus: 2, pro: 3 };

  // Check existing subscription
  const existing = await query('SELECT * FROM subscriptions WHERE user_id = $1', [order.userId]);
  const oldSub = existing.rows[0] ? rowToSub(existing.rows[0]) : null;

  if (oldSub && oldSub.status === 'active' && new Date(oldSub.expiresAt) > now) {
    const newRank = tierRank[order.planKey] ?? 0;
    const oldRank = tierRank[oldSub.planKey] ?? 0;
    const currentEnd = new Date(oldSub.expiresAt);
    const newExpiry = new Date(currentEnd.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
    const newPlan = newRank >= oldRank ? order.planKey : oldSub.planKey;

    const result = await query(
      `UPDATE subscriptions SET plan_key = $2, expires_at = $3, updated_at = $4, last_order_code = $5
       WHERE user_id = $1
       RETURNING *`,
      [order.userId, newPlan, newExpiry, now.toISOString(), order.code],
    );
    return rowToSub(result.rows[0]);
  }

  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  const result = await query(
    `INSERT INTO subscriptions (user_id, user_email, plan_key, status, started_at, expires_at, updated_at, last_order_code)
     VALUES ($1, $2, $3, 'active', $4, $5, $4, $6)
     ON CONFLICT (user_id) DO UPDATE SET
       user_email = $2, plan_key = $3, status = 'active', started_at = $4, expires_at = $5, updated_at = $4, last_order_code = $6
     RETURNING *`,
    [order.userId, order.userEmail, order.planKey, now.toISOString(), expiresAt, order.code],
  );
  return rowToSub(result.rows[0]);
}

export async function getSubscription(userId, userEmail = '') {
  let result = await query('SELECT * FROM subscriptions WHERE user_id = $1', [userId]);
  let sub = rowToSub(result.rows[0]);

  if (!sub && normalizeEmail(userEmail)) {
    const fallbackResult = await query(
      'SELECT * FROM subscriptions WHERE LOWER(user_email) = LOWER($1) ORDER BY updated_at DESC NULLS LAST LIMIT 1',
      [userEmail],
    );
    const legacySub = rowToSub(fallbackResult.rows[0]);
    if (legacySub) {
      if (legacySub.userId !== userId) {
        const migrated = await query(
          `UPDATE subscriptions
           SET user_id = $2, user_email = COALESCE(NULLIF($3, ''), user_email), updated_at = $4
           WHERE user_id = $1
           RETURNING *`,
          [legacySub.userId, userId, userEmail, new Date().toISOString()],
        );
        sub = rowToSub(migrated.rows[0]);
      } else {
        sub = legacySub;
      }
    }
  }

  if (!sub) return null;

  // Auto-expire
  if (sub.status === 'active' && new Date(sub.expiresAt) < new Date()) {
    await query("UPDATE subscriptions SET status = 'expired' WHERE user_id = $1", [userId]);
    sub.status = 'expired';
  }

  return sub;
}

export async function getAllSubscriptions() {
  const result = await query('SELECT * FROM subscriptions');
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

  const order = { code, userId, userEmail, planKey, period, amount: 0, status: 'paid', createdAt: now, paidAt: now, transactionId: `admin:${adminUsername}`, source: 'admin' };
  const subscription = await activateSubscription(order);
  return { order, subscription };
}
