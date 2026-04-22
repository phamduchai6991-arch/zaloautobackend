import { query } from './db.js';

let schemaReady = null;
const GUIDE_KEY = 'guide_manual_content';

export async function ensureGuideContentSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS app_content (
        content_key TEXT PRIMARY KEY,
        content_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by TEXT DEFAULT 'admin'
      )
    `);
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

function normalizeGuideRecord(row) {
  const payload = row?.content_json && typeof row.content_json === 'object' ? row.content_json : {};
  const legacyVideoUrls = Array.isArray(payload.videoUrls) ? payload.videoUrls.map((url) => String(url || '').trim()).filter(Boolean) : [];
  return {
    videoEmbedUrl: String(payload.videoEmbedUrl || legacyVideoUrls[0] || ''),
    updatedAt: row?.updated_at?.toISOString?.() || row?.updated_at || null,
    updatedBy: String(row?.updated_by || payload.updatedBy || 'admin'),
  };
}

export async function getGuideContent() {
  await ensureGuideContentSchema();
  const result = await query(
    `SELECT content_json, updated_at, updated_by
       FROM app_content
      WHERE content_key = $1`,
    [GUIDE_KEY],
  );

  if (!result.rows[0]) {
    return {
      videoEmbedUrl: '',
      updatedAt: null,
      updatedBy: 'admin',
    };
  }

  return normalizeGuideRecord(result.rows[0]);
}

export async function upsertGuideContent({ videoEmbedUrl = '', updatedBy = 'admin' }) {
  await ensureGuideContentSchema();

  const payload = {
    videoEmbedUrl: String(videoEmbedUrl || '').trim(),
    updatedBy: String(updatedBy || 'admin'),
  };

  const result = await query(
    `INSERT INTO app_content (content_key, content_json, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (content_key)
     DO UPDATE SET
       content_json = EXCLUDED.content_json,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING content_json, updated_at, updated_by`,
    [GUIDE_KEY, JSON.stringify(payload), payload.updatedBy],
  );

  return normalizeGuideRecord(result.rows[0]);
}
