const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
  || process.env.VITE_GOOGLE_CLIENT_ID
  || '926356775578-bpfirprc4vbi9n4o3fhubi9p7ddksigs.apps.googleusercontent.com';

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

async function verifyGoogleIdToken(token) {
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

async function verifyGoogleAccessToken(token) {
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
      principal = authType === 'google-access-token'
        ? await verifyGoogleAccessToken(token)
        : await verifyGoogleIdToken(token);
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