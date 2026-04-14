import { query } from './db.js';

let schemaReady = null;

export async function ensureNotificationSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT DEFAULT '',
      read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).then(() =>
    query(`CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications (user_id, created_at DESC)`)
  );
  return schemaReady;
}

export async function createNotification(userId, type, title, body = '') {
  await ensureNotificationSchema();
  const result = await query(
    `INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4) RETURNING *`,
    [userId, type, title, body],
  );
  return result.rows[0];
}

export async function getNotifications(userId, limit = 20) {
  await ensureNotificationSchema();
  const result = await query(
    `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return result.rows;
}

export async function getUnreadCount(userId) {
  await ensureNotificationSchema();
  const result = await query(
    `SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read = FALSE`,
    [userId],
  );
  return result.rows[0]?.count || 0;
}

export async function markAllRead(userId) {
  await ensureNotificationSchema();
  await query(`UPDATE notifications SET read = TRUE WHERE user_id = $1 AND read = FALSE`, [userId]);
}

export async function markRead(userId, notifId) {
  await ensureNotificationSchema();
  await query(`UPDATE notifications SET read = TRUE WHERE id = $1 AND user_id = $2`, [notifId, userId]);
}

// Create subscription-related notifications
export async function notifySubscriptionActivated(userId, planKey, period, expiresAt) {
  const periodLabel = period === 'yearly' ? '1 năm' : '1 tháng';
  const expDate = new Date(expiresAt).toLocaleDateString('vi-VN');
  return createNotification(
    userId,
    'subscription_activated',
    `Gói ${planKey.toUpperCase()} đã kích hoạt`,
    `Gói ${planKey.toUpperCase()} (${periodLabel}) đã được kích hoạt thành công. Hết hạn: ${expDate}.`,
  );
}

export async function notifySubscriptionExpiringSoon(userId, planKey, daysLeft) {
  return createNotification(
    userId,
    'subscription_expiring',
    `Gói ${planKey.toUpperCase()} sắp hết hạn`,
    `Gói của bạn còn ${daysLeft} ngày. Hãy gia hạn để tiếp tục sử dụng.`,
  );
}

export async function notifySubscriptionExpired(userId, planKey) {
  return createNotification(
    userId,
    'subscription_expired',
    `Gói ${planKey.toUpperCase()} đã hết hạn`,
    `Gói của bạn đã hết hạn. Vui lòng gia hạn để tiếp tục sử dụng các tính năng.`,
  );
}

// Check all active subscriptions and create expiry warnings
export async function checkExpiringSubscriptions() {
  await ensureNotificationSchema();

  // Expiring in 3 days — only notify once
  const soonRows = await query(`
    SELECT s.user_id, s.plan_key,
           EXTRACT(DAY FROM s.expires_at - NOW())::int AS days_left
    FROM subscriptions s
    WHERE s.status = 'active'
      AND s.expires_at > NOW()
      AND s.expires_at < NOW() + INTERVAL '3 days'
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = s.user_id
          AND n.type = 'subscription_expiring'
          AND n.created_at > NOW() - INTERVAL '3 days'
      )
  `);

  for (const row of soonRows.rows) {
    await notifySubscriptionExpiringSoon(row.user_id, row.plan_key, row.days_left);
    console.log(`[notif] Expiring soon: ${row.user_id} (${row.days_left}d left)`);
  }

  // Just expired — only notify once
  const expiredRows = await query(`
    SELECT s.user_id, s.plan_key
    FROM subscriptions s
    WHERE s.status = 'active'
      AND s.expires_at < NOW()
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = s.user_id
          AND n.type = 'subscription_expired'
          AND n.created_at > NOW() - INTERVAL '1 day'
      )
  `);

  for (const row of expiredRows.rows) {
    await notifySubscriptionExpired(row.user_id, row.plan_key);
    console.log(`[notif] Expired: ${row.user_id}`);
  }

  return { expiringSoon: soonRows.rowCount, expired: expiredRows.rowCount };
}
