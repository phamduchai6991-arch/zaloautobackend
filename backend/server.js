import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
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
const DIST_DIR = process.env.DIST_DIR || join(__dirname, 'dist');

// ─── CORS ────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://autozalo.vn',
  'https://www.autozalo.vn',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
];

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
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

    // ─── API routes ────────────────────────────────

    if (url.startsWith('/api/')) {

      if (req.method === 'GET' && url === '/api/health') {
        return writeJson(res, 200, { ok: true, service: 'autozalo-backend' });
      }

      if (req.method === 'POST' && url === '/api/payment/create-order') {
        const body = await readBody(req);
        return handleCreateOrder(req, res, body);
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
  console.log(`[autozalo-backend] Serving frontend from: ${DIST_DIR}`);
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
