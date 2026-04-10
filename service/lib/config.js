export const PORT = Number(process.env.ZALO_SERVICE_PORT || 4517);
export const CACHE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

const DEFAULT_ALLOWED_WEB_ORIGINS = [
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'https://autozalo.vn',
  'https://www.autozalo.vn',
];

function normalizeOrigin(value) {
  if (!value) return '';

  try {
    return new URL(value).origin;
  } catch (_) {
    return '';
  }
}

function parseAllowedOrigins(rawValue) {
  const configured = String(rawValue || '')
    .split(',')
    .map((value) => normalizeOrigin(value.trim()))
    .filter(Boolean);

  return Array.from(new Set([...DEFAULT_ALLOWED_WEB_ORIGINS, ...configured]));
}

export const ALLOWED_WEB_ORIGINS = Object.freeze(
  parseAllowedOrigins(process.env.ZALOWEB_ALLOWED_ORIGINS),
);

export function isAllowedWebOrigin(origin) {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) return false;
  return ALLOWED_WEB_ORIGINS.includes(normalizedOrigin);
}