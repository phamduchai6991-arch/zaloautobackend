import { createServer } from 'node:http';
import { PORT } from './lib/config.js';
import { getCachedSessionCount } from './lib/apiClient.js';
import {
  getRequestOrigin,
  hasAllowedOrigin,
  readRequestBody,
  setCorsHeaders,
  writeJson,
} from './lib/http.js';
import {
  handleAccountSync,
  handleActionBatch,
  handleFindUser,
  handleFriendRequestBatch,
  handleGroupInviteTargets,
  handleSendBatch,
} from './lib/handlers.js';

const server = createServer(async (req, res) => {
  setCorsHeaders(res, req);

  if (!hasAllowedOrigin(req)) {
    console.log(`[BLOCKED] ${req.method} ${req.url} origin=${getRequestOrigin(req)}`);
    writeJson(res, 403, {
      ok: false,
      error: 'Origin hiện tại chưa được local service cho phép. Hãy cấu hình ZALOWEB_ALLOWED_ORIGINS trước khi gọi từ web app đã deploy.',
      origin: getRequestOrigin(req),
    });
    return;
  }

  if (req.method !== 'OPTIONS') {
    console.log(`[REQ] ${req.method} ${req.url}`);
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (req.method === 'GET' && req.url === '/health') {
      writeJson(res, 200, {
        ok: true,
        service: 'zaloweb-local-service',
        port: PORT,
        cachedSessions: getCachedSessionCount(),
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/zalo/account/sync') {
      const body = await readRequestBody(req);
      await handleAccountSync(req, res, body);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/zalo/messages/batch') {
      const body = await readRequestBody(req);
      await handleSendBatch(req, res, body);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/zalo/friends/requests/batch') {
      const body = await readRequestBody(req);
      await handleFriendRequestBatch(req, res, body);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/zalo/groups/invite-targets') {
      const body = await readRequestBody(req);
      await handleGroupInviteTargets(req, res, body);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/zalo/find-user') {
      const body = await readRequestBody(req);
      await handleFindUser(req, res, body);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/zalo/actions/batch') {
      const body = await readRequestBody(req);
      await handleActionBatch(req, res, body);
      return;
    }

    writeJson(res, 404, { ok: false, error: 'Endpoint không tồn tại.' });
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : 'Local service gặp lỗi không xác định.',
    });
  }
});

async function checkExistingServiceHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    if (!response.ok) return false;
    const data = await response.json();
    return data?.ok === true && data?.service === 'zaloweb-local-service';
  } catch {
    return false;
  }
}

server.on('error', async (error) => {
  if (error?.code === 'EADDRINUSE') {
    const alreadyRunning = await checkExistingServiceHealth(PORT);
    if (alreadyRunning) {
      console.log(`[zaloweb-service] already running on http://127.0.0.1:${PORT}`);
      process.exit(0);
      return;
    }

    console.error(`[zaloweb-service] port ${PORT} is already in use by another process`);
    process.exit(1);
    return;
  }

  console.error('[zaloweb-service] failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[zaloweb-service] listening on http://127.0.0.1:${PORT}`);
});