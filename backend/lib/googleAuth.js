import { createHmac, randomBytes } from 'node:crypto';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
  || process.env.VITE_GOOGLE_CLIENT_ID
  || '926356775578-bpfirprc4vbi9n4o3fhubi9p7ddksigs.apps.googleusercontent.com';

// Secret for signing session tokens — generated once per process lifetime.
// In production, set SESSION_SECRET env var for persistence across deploys.
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const SESSION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const tokenCache = new Map();

function getCachedPrincipal(cacheKey) {
  const cached = tokenCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    tokenCache.delete(cacheKey);
    return null;
  }
  return cached.principal;
}

function setCachedPrincipal(cacheKey, principal, ttlMs) {
  tokenCache.set(cacheKey, {
    principal,
    expiresAt: Date.now() + Math.max(60_000, ttlMs || 300_000),
  });
}

function writeAuthError(res, statusCode, message) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ ok: false, error: message }));
}

export async function verifyGoogleIdToken(token) {
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
  if (!response.ok) {
    throw new Error('Phiên Google không hợp lệ hoặc đã hết hạn.');
  }

  const data = await response.json();
  if (!data?.sub) {
    throw new Error('Không xác thực được tài khoản Google.');
  }
  if (GOOGLE_CLIENT_ID && data.aud && data.aud !== GOOGLE_CLIENT_ID) {
    throw new Error('Google token không thuộc ứng dụng này.');
  }

  return {
    sub: String(data.sub),
    email: String(data.email || '').trim(),
    expiresAt: Number(data.exp || 0) * 1000 || (Date.now() + 300_000),
  };
}

export async function verifyGoogleAccessToken(token) {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error('Google access token không hợp lệ hoặc đã hết hạn.');
  }

  const data = await response.json();
  if (!data?.sub) {
    throw new Error('Không lấy được thông tin user từ Google.');
  }

  return {
    sub: String(data.sub),
    email: String(data.email || '').trim(),
    expiresAt: Date.now() + 300_000,
  };
}

// ─── Self-issued session tokens (long-lived) ─────────────

function signPayload(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', SESSION_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifySignature(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expected = createHmac('sha256', SESSION_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  if (signature !== expected) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }
}

export function createSessionToken(sub, email) {
  const now = Date.now();
  return {
    token: signPayload({
      sub: String(sub),
      email: String(email || ''),
      iat: Math.floor(now / 1000),
      exp: Math.floor((now + SESSION_TOKEN_TTL_MS) / 1000),
    }),
    expiresAt: now + SESSION_TOKEN_TTL_MS,
  };
}

function verifySessionToken(token) {
  const payload = verifySignature(token);
  if (!payload) throw new Error('Session token không hợp lệ.');
  if (!payload.sub) throw new Error('Session token thiếu thông tin user.');
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp && nowSec >= payload.exp) {
    throw new Error('Session token đã hết hạn. Vui lòng đăng nhập lại.');
  }
  return {
    sub: String(payload.sub),
    email: String(payload.email || '').trim(),
    expiresAt: (payload.exp || 0) * 1000,
  };
}

export async function requireAuthenticatedGoogleUser(req, res, expectedUserId = '') {
  const authHeader = req.headers.authorization || '';
  const authType = String(req.headers['x-autozalo-auth-type'] || '').trim();
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token || !authType) {
    writeAuthError(res, 401, 'Thiếu thông tin xác thực Google. Vui lòng đăng nhập lại.');
    return null;
  }

  const cacheKey = `${authType}:${token}`;
  let principal = getCachedPrincipal(cacheKey);

  try {
    if (!principal) {
      if (authType === 'autozalo-session') {
        principal = verifySessionToken(token);
      } else if (authType === 'google-access-token') {
        principal = await verifyGoogleAccessToken(token);
      } else {
        principal = await verifyGoogleIdToken(token);
      }
      setCachedPrincipal(cacheKey, principal, principal.expiresAt - Date.now());
    }
  } catch (error) {
    writeAuthError(res, 401, error instanceof Error ? error.message : 'Xác thực Google thất bại.');
    return null;
  }

  if (expectedUserId && principal.sub !== String(expectedUserId)) {
    writeAuthError(res, 403, 'Bạn không có quyền thao tác tài khoản của người dùng khác.');
    return null;
  }

  return principal;
}