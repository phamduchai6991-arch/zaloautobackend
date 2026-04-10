import { createHash } from 'node:crypto';
import { Zalo } from 'zalo-api-final';
import { CACHE_TTL_MS, DEFAULT_USER_AGENT } from './config.js';

const sessionCache = new Map();

function normalizeCookies(account) {
  if (Array.isArray(account?.cookies) && account.cookies.length > 0) {
    return account.cookies
      .filter((cookie) => cookie && cookie.name && typeof cookie.value === 'string')
      .map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain || '.zalo.me',
        path: cookie.path || '/',
        httpOnly: Boolean(cookie.httpOnly),
        secure: cookie.secure !== false,
        sameSite: cookie.sameSite,
        expirationDate: cookie.expirationDate,
        session: cookie.session,
      }));
  }

  if (typeof account?.cookie === 'string' && account.cookie.trim()) {
    return account.cookie
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf('=');
        if (separatorIndex <= 0) return null;
        return {
          name: part.slice(0, separatorIndex).trim(),
          value: part.slice(separatorIndex + 1).trim(),
          domain: '.zalo.me',
          path: '/',
          httpOnly: false,
          secure: true,
        };
      })
      .filter(Boolean);
  }

  return [];
}

export function getUserAgent(body, req) {
  return (
    body?.userAgent ||
    body?.account?.userAgent ||
    req.headers['x-user-agent'] ||
    DEFAULT_USER_AGENT
  );
}

function buildCredentials(account, userAgent) {
  const cookies = normalizeCookies(account);
  if (!cookies.length) {
    throw new Error('Tài khoản chưa có cookie Zalo. Hãy đồng bộ lại tài khoản trước khi gửi.');
  }

  if (!account?.imei) {
    throw new Error('Tài khoản chưa có IMEI/session identity. Hãy đồng bộ lại tài khoản trước khi gửi.');
  }

  return {
    imei: account.imei,
    cookie: cookies,
    userAgent: userAgent || DEFAULT_USER_AGENT,
    language: 'vi',
  };
}

function buildCacheKey(account, credentials) {
  const fingerprint = createHash('sha1')
    .update(JSON.stringify({
      id: account?.id,
      userId: account?.userId,
      UIN: account?.UIN,
      imei: credentials.imei,
      userAgent: credentials.userAgent,
      cookies: credentials.cookie,
    }))
    .digest('hex');

  return `${account?.id || account?.userId || account?.UIN || 'account'}:${fingerprint}`;
}

export async function createApiClient(account, userAgent) {
  const credentials = buildCredentials(account, userAgent);
  const cacheKey = buildCacheKey(account, credentials);
  const cached = sessionCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.createdAt < CACHE_TTL_MS) {
    try {
      if (typeof cached.api.keepAlive === 'function') {
        await cached.api.keepAlive();
      }
      return { api: cached.api, cacheKey };
    } catch (_) {
      sessionCache.delete(cacheKey);
    }
  }

  const zalo = new Zalo({
    selfListen: false,
    logging: false,
    checkUpdate: false,
  });

  try {
    const api = await zalo.login(credentials);
    sessionCache.set(cacheKey, { api, createdAt: now });
    return { api, cacheKey };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('Đăng nhập thất bại') || msg.includes('Missing required params')) {
      throw new Error('Phiên đăng nhập Zalo đã hết hạn. Hãy làm mới tài khoản (đăng nhập lại qua extension) để lấy cookie mới.');
    }
    throw error;
  }
}

export function getCachedSessionCount() {
  return sessionCache.size;
}