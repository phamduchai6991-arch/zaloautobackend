import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  handleCreateOrder,
  handleGetOrder,
  handleGetUserOrders,
  handleGetSubscription,
  handleSepayWebhook,
  cleanupExpiredOrders,
  writeJson,
  readBody,
} from './lib/paymentHandlers.js';
import {
  handleAdminStats,
  handleAdminUsers,
  handleAdminOrders,
  handleAdminLogin,
  handleAdminGrantSubscription,
} from './lib/adminHandlers.js';
import { handleSyncUser } from './lib/userHandlers.js';
import {
  handleAccountSync,
  handleSendBatch,
  handleFriendRequestBatch,
  handleGroupInviteTargets,
  handleActionBatch,
} from '../service/lib/handlers.js';

// Load .env file
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

const PORT = Number(process.env.PORT || 3000);
const configuredDistDir = process.env.FRONTEND_DIST_DIR?.trim();
const DIST_DIR = configuredDistDir
  ? (isAbsolute(configuredDistDir)
      ? configuredDistDir
      : resolve(__dirname, configuredDistDir))
  : join(__dirname, '..', 'frontend', 'dist');
const HAS_DIST = existsSync(join(DIST_DIR, 'index.html'));

// ─── CORS ────────────────────────────────────────────────

const DEFAULT_ALLOWED_ORIGINS = [
  'https://autozalo.vn',
  'https://www.autozalo.vn',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
];

const ALLOWED_ORIGINS = new Set([
  ...DEFAULT_ALLOWED_ORIGINS,
  ...(process.env.ZALOWEB_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
]);

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

// ─── Static file serving ─────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.zip':  'application/zip',
};

function serveStatic(res, urlPath) {
  if (!HAS_DIST) {
    if (urlPath === '/') {
      return writeJson(res, 200, {
        ok: true,
        service: 'autozalo-backend',
        mode: 'api-only',
      });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Frontend build not deployed on this service.');
    return;
  }

  // Prevent path traversal
  const safePath = urlPath.replace(/\.\./g, '').replace(/\/\//g, '/');
  let filePath = join(DIST_DIR, safePath === '/' ? 'index.html' : safePath);

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // SPA fallback: serve index.html for any non-file route
    filePath = join(DIST_DIR, 'index.html');
    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
  }

  const ext = extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  const body = readFileSync(filePath);

  // Cache static assets (hashed filenames)
  const cacheControl = ext === '.html'
    ? 'no-cache'
    : 'public, max-age=31536000, immutable';

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': body.length,
    'Cache-Control': cacheControl,
  });
  res.end(body);
}

// ─── Server ──────────────────────────────────────────────

const server = createServer(async (req, res) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const url = req.url?.split('?')[0] || '/';

    if (req.method === 'POST' && url === '/sepay_webhook.php') {
      const body = await readBody(req);
      return handleSepayWebhook(req, res, body);
    }

    // ─── API routes ────────────────────────────────

    if (url.startsWith('/api/')) {

      if (req.method === 'GET' && url === '/api/health') {
        return writeJson(res, 200, { ok: true, service: 'autozalo-backend' });
      }

      if (req.method === 'POST' && url === '/api/payment/create-order') {
        const body = await readBody(req);
        return handleCreateOrder(req, res, body);
      }

      if (req.method === 'POST' && url === '/api/users/sync') {
        const body = await readBody(req);
        return handleSyncUser(req, res, body);
      }

      const orderMatch = url.match(/^\/api\/payment\/orders\/([A-Z0-9]+)$/);
      if (req.method === 'GET' && orderMatch) {
        return handleGetOrder(req, res, orderMatch[1]);
      }

      const userOrdersMatch = url.match(/^\/api\/payment\/users\/([^/]+)\/orders$/);
      if (req.method === 'GET' && userOrdersMatch) {
        return handleGetUserOrders(req, res, decodeURIComponent(userOrdersMatch[1]));
      }

      const subMatch = url.match(/^\/api\/payment\/subscription\/([^/]+)$/);
      if (req.method === 'GET' && subMatch) {
        return handleGetSubscription(req, res, decodeURIComponent(subMatch[1]));
      }

      if (req.method === 'POST' && url === '/api/payment/webhook/sepay') {
        const body = await readBody(req);
        return handleSepayWebhook(req, res, body);
      }

      if (req.method === 'POST' && url === '/api/admin/login') {
        const body = await readBody(req);
        return handleAdminLogin(req, res, body);
      }

      if (req.method === 'GET' && url === '/api/admin/stats') {
        return handleAdminStats(req, res);
      }

      if (req.method === 'GET' && url === '/api/admin/users') {
        return handleAdminUsers(req, res);
      }

      if (req.method === 'GET' && url === '/api/admin/orders') {
        return handleAdminOrders(req, res);
      }

      if (req.method === 'POST' && url === '/api/admin/grant-subscription') {
        const body = await readBody(req);
        return handleAdminGrantSubscription(req, res, body);
      }

      // ─── Zalo API proxy routes (uses zalo-api-final) ───

      if (req.method === 'POST' && url === '/api/zalo/account/sync') {
        const body = await readBody(req);
        return handleAccountSync(req, res, body);
      }

      if (req.method === 'POST' && url === '/api/zalo/messages/batch') {
        const body = await readBody(req);
        return handleSendBatch(req, res, body);
      }

      if (req.method === 'POST' && url === '/api/zalo/friends/requests/batch') {
        const body = await readBody(req);
        return handleFriendRequestBatch(req, res, body);
      }

      if (req.method === 'POST' && url === '/api/zalo/groups/invite-targets') {
        const body = await readBody(req);
        return handleGroupInviteTargets(req, res, body);
      }

      if (req.method === 'POST' && url === '/api/zalo/actions/batch') {
        const body = await readBody(req);
        return handleActionBatch(req, res, body);
      }

      return writeJson(res, 404, { ok: false, error: 'API endpoint không tồn tại.' });
    }

    // ─── Static files (built frontend) ─────────────

    serveStatic(res, url);

  } catch (error) {
    console.error('[backend] Error:', error);
    writeJson(res, 500, { ok: false, error: 'Server error.' });
  }
});

server.listen(PORT, () => {
  console.log(`[autozalo-backend] listening on http://0.0.0.0:${PORT}`);
  console.log(`[autozalo-backend] Frontend mode: ${HAS_DIST ? 'static bundle' : 'api-only'}`);
  console.log(`[autozalo-backend] Frontend path: ${DIST_DIR}`);
  console.log(`[autozalo-backend] Allowed origins: ${Array.from(ALLOWED_ORIGINS).join(', ') || '(none)'}`);
  console.log(`[autozalo-backend] SePay webhook: POST /api/payment/webhook/sepay`);

  // Cleanup expired orders every hour
  setInterval(cleanupExpiredOrders, 60 * 60 * 1000);
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`[autozalo-backend] Port ${PORT} is already in use.`);
    process.exit(1);
  }
  console.error('[autozalo-backend] Failed to start:', error);
  process.exit(1);
});
