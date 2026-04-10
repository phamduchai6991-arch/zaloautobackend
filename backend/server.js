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
  getAccountsByUser,
  registerAccount,
  removeAccount,
  touchAccount,
  PLAN_LIMITS,
} from './lib/accountStore.js';
import {
  handleAccountSync,
  handleSendBatch,
  handleFriendRequestBatch,
  handleGroupInviteTargets,
  handleActionBatch,
} from '../service/lib/handlers.js';
import { createApiClient, getUserAgent } from '../service/lib/apiClient.js';
import { isGroupJob, normalizeThreadId, getDelayMs, sleep } from '../service/lib/zaloHelpers.js';
import { ThreadType } from 'zalo-api-final';

// ─── Streaming NDJSON helpers ────────────────────────────

function writeNdjsonLine(res, data) {
  res.write(JSON.stringify(data) + '\n');
}

async function handleSendBatchStream(req, res, body) {
  const account = body?.account;
  const jobs = Array.isArray(body?.jobs) ? body.jobs : [];

  if (!account) {
    writeJson(res, 400, { ok: false, error: 'Thiếu account để gửi tin.' });
    return;
  }
  if (!jobs.length) {
    writeJson(res, 400, { ok: false, error: 'Danh sách jobs rỗng.' });
    return;
  }

  const userAgent = getUserAgent(body, req);
  let api;
  try {
    ({ api } = await createApiClient(account, userAgent));
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : 'Không thể khởi tạo phiên Zalo.',
      code: 'SERVICE_LOGIN_FAILED',
    });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache',
  });

  // Convert base64 files to Buffer attachments (shared across all jobs)
  const rawFiles = Array.isArray(body?.files) ? body.files : [];
  const attachments = rawFiles
    .filter((f) => f && typeof f.name === 'string' && typeof f.data === 'string')
    .map((f) => ({ data: Buffer.from(f.data, 'base64'), filename: f.name }));

  let accepted = 0;
  let failed = 0;

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const groupJob = isGroupJob(job);
    const zid = normalizeThreadId(job?.zid, groupJob);
    const content = String(job?.content || '').trim();
    const hasAttachments = attachments.length > 0;
    const startedAt = new Date().toISOString();

    // Emit "running" status
    writeNdjsonLine(res, {
      jobId: job.id,
      status: 'running',
      statusLabel: `Đang gửi ${index + 1}/${jobs.length}`,
      startedAt,
      provider: 'server',
    });

    if (!zid || zid === '—') {
      failed++;
      writeNdjsonLine(res, {
        jobId: job?.id, ok: false, status: 'failed',
        statusLabel: 'Thiếu Zalo ID',
        error: 'Job không có Zalo ID hợp lệ.',
        startedAt, failedAt: new Date().toISOString(), provider: 'server',
      });
      continue;
    }

    if (!content && !hasAttachments) {
      failed++;
      writeNdjsonLine(res, {
        jobId: job?.id, ok: false, status: 'failed',
        statusLabel: 'Thiếu nội dung',
        error: 'Job không có nội dung tin nhắn.',
        startedAt, failedAt: new Date().toISOString(), provider: 'server',
      });
      continue;
    }

    try {
      const threadType = groupJob ? ThreadType.Group : ThreadType.User;
      const msgPayload = hasAttachments ? { msg: content, attachments } : content;
      const apiResult = await api.sendMessage(msgPayload, zid, threadType);
      accepted++;
      writeNdjsonLine(res, {
        jobId: job.id, ok: true, status: 'sent',
        statusLabel: 'Đã gửi',
        startedAt, sentAt: new Date().toISOString(), provider: 'server',
        apiResult,
      });
    } catch (error) {
      failed++;
      writeNdjsonLine(res, {
        jobId: job?.id, ok: false, status: 'failed',
        statusLabel: 'Gửi thất bại',
        error: error instanceof Error ? error.message : 'Gửi tin nhắn thất bại.',
        startedAt, failedAt: new Date().toISOString(), provider: 'server',
      });
    }

    if (index < jobs.length - 1) {
      const delayMs = getDelayMs(job?.delayWindow);
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  writeNdjsonLine(res, { _done: true, ok: true, accepted, failed });
  res.end();
}

async function handleFriendRequestBatchStream(req, res, body) {
  const account = body?.account;
  const jobs = Array.isArray(body?.jobs) ? body.jobs : [];

  if (!account) {
    writeJson(res, 400, { ok: false, error: 'Thiếu account để gửi lời mời kết bạn.' });
    return;
  }
  if (!jobs.length) {
    writeJson(res, 400, { ok: false, error: 'Danh sách job kết bạn rỗng.' });
    return;
  }

  const userAgent = getUserAgent(body, req);
  let api;
  try {
    ({ api } = await createApiClient(account, userAgent));
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : 'Không thể khởi tạo phiên Zalo.',
      code: 'SERVICE_LOGIN_FAILED',
    });
    return;
  }

  // ensureCustomApiActions — inline subset needed for friend requests
  if (typeof api?.custom === 'function' && typeof api.rejectFriendRequest !== 'function') {
    api.custom('rejectFriendRequest', async ({ ctx, utils, props }) => {
      const userId = String(props?.userId || props || '').trim();
      const serviceURL = utils.makeURL(`${api.zpwServiceMap.friend[0]}/api/friend/reject`);
      const encryptedParams = utils.encodeAES(JSON.stringify({ fid: userId, language: ctx.language }));
      if (!encryptedParams) throw new Error('Failed to encrypt params');
      const response = await utils.request(serviceURL, {
        method: 'POST',
        body: new URLSearchParams({ params: encryptedParams }),
      });
      return utils.resolve(response);
    });
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache',
  });

  let accepted = 0;
  let failed = 0;

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const userId = String(job?.zid || '').trim();
    const note = String(job?.note || '').trim();
    const startedAt = new Date().toISOString();

    writeNdjsonLine(res, {
      jobId: job.id,
      status: 'running',
      statusLabel: `Đang kết bạn ${index + 1}/${jobs.length}`,
      startedAt,
      provider: 'server',
    });

    if (!userId || userId === '—') {
      failed++;
      writeNdjsonLine(res, {
        jobId: job?.id, ok: false, status: 'failed',
        statusLabel: 'Thiếu Zalo ID',
        error: 'Job không có Zalo ID hợp lệ.',
        startedAt, failedAt: new Date().toISOString(), provider: 'server',
      });
      continue;
    }

    try {
      const apiResult = await api.sendFriendRequest(note, userId);
      accepted++;
      writeNdjsonLine(res, {
        jobId: job.id, ok: true, status: 'sent',
        statusLabel: 'Đã gửi lời mời',
        startedAt, sentAt: new Date().toISOString(), provider: 'server',
        apiResult,
      });
    } catch (error) {
      const code = typeof error?.code === 'number' ? error.code : null;
      if (code === 222) {
        accepted++;
        writeNdjsonLine(res, {
          jobId: job.id, ok: true, status: 'accepted',
          statusLabel: 'Đã chấp nhận lời mời',
          startedAt, sentAt: new Date().toISOString(), provider: 'server',
        });
      } else if (code === 225) {
        accepted++;
        writeNdjsonLine(res, {
          jobId: job.id, ok: true, status: 'skipped',
          statusLabel: 'Đã là bạn bè',
          startedAt, sentAt: new Date().toISOString(), provider: 'server',
        });
      } else {
        failed++;
        writeNdjsonLine(res, {
          jobId: job?.id, ok: false, status: 'failed',
          statusLabel: 'Kết bạn thất bại',
          error: error instanceof Error ? error.message : 'Gửi lời mời kết bạn thất bại.',
          startedAt, failedAt: new Date().toISOString(), provider: 'server',
        });
      }
    }

    if (index < jobs.length - 1) {
      const delayMs = getDelayMs(job?.delayWindow);
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  writeNdjsonLine(res, { _done: true, ok: true, accepted, failed });
  res.end();
}

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
    const fullUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const url = fullUrl.pathname;

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

      // ─── Zalo account tracking (server-side limit enforcement) ───

      // GET /api/accounts?userId=xxx — list registered Zalo accounts
      if (req.method === 'GET' && url === '/api/accounts') {
        const userId = fullUrl.searchParams.get('userId');
        if (!userId) return writeJson(res, 400, { ok: false, error: 'Thiếu userId.' });
        const accounts = await getAccountsByUser(userId);
        return writeJson(res, 200, { ok: true, accounts });
      }

      // POST /api/accounts/register — register a Zalo account for a user
      if (req.method === 'POST' && url === '/api/accounts/register') {
        const body = await readBody(req);
        const { userId, zaloId, zaloName, zaloAvatar, zaloPhone } = body || {};
        if (!userId || !zaloId) return writeJson(res, 400, { ok: false, error: 'Thiếu userId hoặc zaloId.' });
        // Look up actual subscription server-side — don't trust client planKey
        const { getSubscription } = await import('./lib/paymentStore.js');
        const sub = await getSubscription(userId);
        const planKey = (sub?.status === 'active' ? sub.planKey : null) || 'basic';
        const result = await registerAccount({ userId, planKey, zaloId, zaloName, zaloAvatar, zaloPhone });
        return writeJson(res, result.ok ? 200 : 403, result);
      }

      // POST /api/accounts/remove — remove a Zalo account
      if (req.method === 'POST' && url === '/api/accounts/remove') {
        const body = await readBody(req);
        const { userId, zaloId } = body || {};
        if (!userId || !zaloId) return writeJson(res, 400, { ok: false, error: 'Thiếu userId hoặc zaloId.' });
        const removed = await removeAccount(userId, zaloId);
        return writeJson(res, 200, { ok: true, removed });
      }

      // ─── Zalo API proxy routes (uses zalo-api-final) ───

      if (req.method === 'POST' && url === '/api/zalo/account/sync') {
        const body = await readBody(req);
        return handleAccountSync(req, res, body);
      }

      if (req.method === 'POST' && url === '/api/zalo/messages/batch') {
        const body = await readBody(req);
        return handleSendBatchStream(req, res, body);
      }

      if (req.method === 'POST' && url === '/api/zalo/friends/requests/batch') {
        const body = await readBody(req);
        return handleFriendRequestBatchStream(req, res, body);
      }

      if (req.method === 'POST' && url === '/api/zalo/groups/invite-targets') {
        const body = await readBody(req);
        return handleGroupInviteTargets(req, res, body);
      }

      if (req.method === 'POST' && url === '/api/zalo/actions/batch') {
        const body = await readBody(req);
        return handleActionBatch(req, res, body);
      }

      // ─── AI Rewrite (DeepSeek proxy) ───

      if (req.method === 'POST' && url === '/api/ai/rewrite') {
        const body = await readBody(req);
        const text = String(body?.text || '').trim();
        const target = body?.target || 'message'; // 'message' or 'friend'
        if (!text) return writeJson(res, 400, { ok: false, error: 'Thiếu nội dung để viết lại.' });
        const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'sk-6b3964ea846f4e1daabcf8f0c4000986';
        const systemPrompt = target === 'friend'
          ? 'Bạn là trợ lý viết lại tin nhắn kết bạn Zalo. Hãy viết lại nội dung sau thành 3 phiên bản khác nhau: 1 bản lịch sự chuyên nghiệp, 1 bản thân thiện gần gũi, 1 bản ngắn gọn súc tích. Mỗi bản tối đa 150 ký tự. Trả về JSON array gồm 3 string, không giải thích thêm.'
          : 'Bạn là trợ lý viết lại tin nhắn Zalo. Hãy viết lại nội dung sau thành 3 phiên bản khác nhau: 1 bản lịch sự chuyên nghiệp, 1 bản thân thiện gần gũi, 1 bản ngắn gọn súc tích. Trả về JSON array gồm 3 string, không giải thích thêm.';
        try {
          const resp = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
            body: JSON.stringify({
              model: 'deepseek-chat',
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: text },
              ],
              temperature: 0.8,
            }),
          });
          if (!resp.ok) {
            const errText = await resp.text();
            return writeJson(res, 502, { ok: false, error: `DeepSeek API error: ${resp.status}`, detail: errText });
          }
          const data = await resp.json();
          const raw = data?.choices?.[0]?.message?.content || '[]';
          let options;
          try {
            // Extract JSON array from response (may be wrapped in markdown code block)
            const jsonMatch = raw.match(/\[[\s\S]*\]/);
            options = jsonMatch ? JSON.parse(jsonMatch[0]) : [raw];
          } catch (_) {
            options = [raw];
          }
          return writeJson(res, 200, { ok: true, options });
        } catch (error) {
          return writeJson(res, 502, { ok: false, error: error instanceof Error ? error.message : 'DeepSeek API unreachable.' });
        }
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
