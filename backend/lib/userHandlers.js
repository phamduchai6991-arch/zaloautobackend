import { upsertUser } from './userStore.js';

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export function handleSyncUser(req, res, body) {
  const { userId, email, name, picture } = body || {};

  if (!userId || !email) {
    return writeJson(res, 400, { ok: false, error: 'Thiếu userId hoặc email.' });
  }

  const user = upsertUser({ userId, email, name, picture });
  return writeJson(res, 200, { ok: true, user });
}