import { query } from './db.js';

let schemaReadyPromise = null;

function hasDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

export async function ensureMessageHistorySchema() {
  if (!hasDatabaseConfigured()) return false;
  if (schemaReadyPromise) return schemaReadyPromise;

  schemaReadyPromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS zalo_message_history (
        owner_user_id TEXT NOT NULL,
        account_zalo_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        is_group BOOLEAN NOT NULL DEFAULT false,
        msg_id TEXT NOT NULL,
        from_id TEXT DEFAULT '',
        to_id TEXT DEFAULT '',
        content TEXT DEFAULT '',
        raw_content JSONB,
        msg_type TEXT DEFAULT 'text',
        ts_ms BIGINT NOT NULL DEFAULT 0,
        sender_name TEXT DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_user_id, account_zalo_id, conversation_id, msg_id)
      )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_zalo_message_history_lookup
      ON zalo_message_history (owner_user_id, account_zalo_id, conversation_id, ts_ms DESC)
    `);
  })().catch((error) => {
    schemaReadyPromise = null;
    throw error;
  });

  return schemaReadyPromise;
}

function normalizeTimestamp(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num <= 0) return Date.now();
  if (num < 1e12) return num * 1000;
  return Math.floor(num);
}

function sanitizeMessage(message) {
  if (!message || typeof message !== 'object') return null;

  const msgId = String(
    message.msgId || message.globalMsgId || message.actionId || message.realMsgId || message.cliMsgId || message.id || ''
  ).trim();
  if (!msgId) return null;

  return {
    msgId,
    fromId: String(message.fromId || message.uidFrom || message.fromUid || message.senderId || '').trim(),
    toId: String(message.toId || message.idTo || message.toUid || '').trim(),
    content: String(message.content || '').trim(),
    rawContent: message.rawContent ?? null,
    msgType: String(message.msgType || message.type || 'text').trim() || 'text',
    ts: normalizeTimestamp(message.ts || message.sendDttm || message.createTime || message.time || 0),
    dName: String(message.dName || message.senderName || message.fromName || message.displayName || '').trim(),
  };
}

export async function listMessageHistory({ ownerUserId, accountZaloId, conversationId, limit = 30 }) {
  if (!hasDatabaseConfigured()) return [];
  await ensureMessageHistorySchema();

  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 30));
  const result = await query(
    `SELECT msg_id, from_id, to_id, content, raw_content, msg_type, ts_ms, sender_name
       FROM zalo_message_history
      WHERE owner_user_id = $1
        AND account_zalo_id = $2
        AND conversation_id = $3
      ORDER BY ts_ms DESC, updated_at DESC
      LIMIT $4`,
    [ownerUserId, accountZaloId, conversationId, safeLimit],
  );

  return result.rows
    .map((row) => ({
      msgId: String(row.msg_id || ''),
      fromId: String(row.from_id || ''),
      toId: String(row.to_id || ''),
      content: String(row.content || ''),
      rawContent: row.raw_content ?? null,
      msgType: String(row.msg_type || 'text'),
      ts: Number(row.ts_ms || 0),
      dName: String(row.sender_name || ''),
    }))
    .reverse();
}

export async function upsertMessageHistory({ ownerUserId, accountZaloId, conversationId, isGroup, messages }) {
  if (!hasDatabaseConfigured()) return 0;
  if (!Array.isArray(messages) || messages.length === 0) return 0;

  await ensureMessageHistorySchema();

  let written = 0;
  for (const rawMessage of messages) {
    const message = sanitizeMessage(rawMessage);
    if (!message) continue;

    await query(
      `INSERT INTO zalo_message_history
       (owner_user_id, account_zalo_id, conversation_id, is_group, msg_id, from_id, to_id, content, raw_content, msg_type, ts_ms, sender_name, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, now())
       ON CONFLICT (owner_user_id, account_zalo_id, conversation_id, msg_id)
       DO UPDATE SET
         from_id = EXCLUDED.from_id,
         to_id = EXCLUDED.to_id,
         content = EXCLUDED.content,
         raw_content = EXCLUDED.raw_content,
         msg_type = EXCLUDED.msg_type,
         ts_ms = EXCLUDED.ts_ms,
         sender_name = EXCLUDED.sender_name,
         is_group = EXCLUDED.is_group,
         updated_at = now()`,
      [
        ownerUserId,
        accountZaloId,
        conversationId,
        Boolean(isGroup),
        message.msgId,
        message.fromId,
        message.toId,
        message.content,
        message.rawContent ? JSON.stringify(message.rawContent) : null,
        message.msgType,
        message.ts,
        message.dName,
      ],
    );

    written += 1;
  }

  return written;
}
