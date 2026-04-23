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
  handleAdminGetGuideContent,
  handleAdminUpdateGuideContent,
  handleAdminLogin,
  handleAdminGrantSubscription,
  handleAdminListCategories,
  handleAdminCreateCategory,
  handleAdminUpdateCategory,
  handleAdminDeleteCategory,
  handleAdminListGroups,
  handleAdminBulkAddGroups,
  handleAdminUpdateGroup,
  handleAdminDeleteGroup,
  handleAdminGroupLibraryStats,
} from './lib/adminHandlers.js';
import { handleSyncUser } from './lib/userHandlers.js';
import {
  getNotifications,
  getUnreadCount,
  markAllRead,
  markRead,
  checkExpiringSubscriptions,
  ensureNotificationSchema,
} from './lib/notificationStore.js';
import {
  listCategories as publicListCategories,
  listGroups as publicListGroups,
  ensureGroupLibrarySchema,
} from './lib/groupLibraryStore.js';
import { ensureGuideContentSchema, getGuideContent } from './lib/guideContentStore.js';
import {
  getAccount,
  getAccountsByUser,
  registerAccount,
  removeAccount,
  touchAccount,
  PLAN_LIMITS,
} from './lib/accountStore.js';
import {
  ensureMessageHistorySchema,
  listMessageHistory,
  listLatestConversationMessages,
  upsertMessageHistory,
} from './lib/messageHistoryStore.js';
import {
  handleAccountSync,
  handleSendBatch,
  handleFriendRequestBatch,
  handleGroupInviteTargets,
  handleFindUser,
  handleActionBatch,
  ensureCustomApiActions,
} from '../service/lib/handlers.js';
import { requireAuthenticatedGoogleUser, createSessionToken, verifyGoogleIdToken, verifyGoogleAccessToken } from './lib/googleAuth.js';
import { createApiClient, getUserAgent } from '../service/lib/apiClient.js';
import { isGroupJob, normalizeThreadId, getDelayMs, sleep, chunk, summarizeGroupMap } from '../service/lib/zaloHelpers.js';
import { MuteAction, MuteDuration, ThreadType } from 'zalo-api-final';

// ─── Streaming NDJSON helpers ────────────────────────────

function writeNdjsonLine(res, data) {
  res.write(JSON.stringify(data) + '\n');
}

function normalizeHistoryTimestamp(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num <= 0) return Date.now();
  if (num < 1e12) return Math.floor(num * 1000);
  return Math.floor(num);
}

function extractHistoryContent(value, depth = 0) {
  if (depth > 4 || value == null) return '';
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '';
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        const nested = extractHistoryContent(parsed, depth + 1);
        if (nested) return nested;
      } catch (_) {
        return text;
      }
    }
    return text;
  }
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractHistoryContent(item, depth + 1);
      if (nested) return nested;
    }
    return '';
  }
  if (typeof value !== 'object') return '';

  const direct = [
    value.text,
    value.content,
    value.description,
    value.title,
    value.caption,
    value.msg,
    value.message,
    value.body,
    value.summary,
  ];
  for (const candidate of direct) {
    const nested = extractHistoryContent(candidate, depth + 1);
    if (nested) return nested;
  }

  const nestedCandidates = [
    value.data,
    value.params,
    value.meta,
    value.attach,
    value.attachment,
    value.attachments,
    value.payload,
    value.extra,
    value.quote,
  ];
  for (const candidate of nestedCandidates) {
    const nested = extractHistoryContent(candidate, depth + 1);
    if (nested) return nested;
  }

  return '';
}

function normalizeHistoryMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const fromId = String(raw.uidFrom || raw.fromUid || raw.fromId || raw.senderId || raw.uid || '').trim();
  const toId = String(raw.idTo || raw.toId || raw.toUid || '').trim();
  const msgId = String(raw.msgId || raw.globalMsgId || raw.actionId || raw.realMsgId || raw.cliMsgId || raw.id || '').trim();
  if (!msgId) return null;

  const content = String(raw.content || '').trim() || extractHistoryContent(raw.content) || extractHistoryContent(raw.rawContent) || extractHistoryContent(raw);

  return {
    msgId,
    fromId,
    toId,
    content,
    rawContent: raw.rawContent ?? raw,
    ts: normalizeHistoryTimestamp(raw.ts || raw.sendDttm || raw.createTime || raw.time || 0),
    msgType: String(raw.msgType || raw.type || 'text').trim() || 'text',
    dName: String(raw.dName || raw.senderName || raw.fromName || raw.displayName || '').trim(),
  };
}

function extractHistoryMessages(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (typeof result === 'string') {
    const text = result.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      return extractHistoryMessages(parsed);
    } catch (_) {
      return [];
    }
  }
  if (typeof result !== 'object') return [];

  if (Array.isArray(result.msgs)) return result.msgs;
  if (Array.isArray(result.groupMsgs)) return result.groupMsgs;
  if (Array.isArray(result.messages)) return result.messages;

  if (result.data && typeof result.data === 'object') {
    if (Array.isArray(result.data.msgs)) return result.data.msgs;
    if (Array.isArray(result.data.groupMsgs)) return result.data.groupMsgs;
    if (Array.isArray(result.data.messages)) return result.data.messages;
  }

  if (typeof result.data === 'string' && result.data.length > 2) {
    try {
      const parsed = JSON.parse(result.data);
      if (Array.isArray(parsed?.msgs)) return parsed.msgs;
      if (Array.isArray(parsed?.groupMsgs)) return parsed.groupMsgs;
      if (Array.isArray(parsed?.messages)) return parsed.messages;
    } catch (_) {
      return [];
    }
  }

  return [];
}

function mergeHistoryMessages(...messageLists) {
  const merged = [];
  const seen = new Set();

  for (const list of messageLists) {
    for (const message of Array.isArray(list) ? list : []) {
      const normalized = normalizeHistoryMessage(message);
      if (!normalized) continue;
      if (seen.has(normalized.msgId)) continue;
      seen.add(normalized.msgId);
      merged.push(normalized);
    }
  }

  return merged.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
}

function mapRealtimeChange(row) {
  return {
    conversationId: String(row?.conversationId || ''),
    ts: Number(row?.ts || 0),
    isGroup: Boolean(row?.isGroup),
    lastMessage: String(row?.content || ''),
    lastMsgId: String(row?.msgId || ''),
    lastMsgType: String(row?.msgType || 'text'),
    lastSenderId: String(row?.fromId || ''),
    lastSenderName: String(row?.dName || ''),
  };
}

async function buildRealtimeChanges({ ownerUserId, accountZaloId, sinceTs }) {
  const rows = await listLatestConversationMessages({ ownerUserId, accountZaloId, limit: 1000 });
  const changed = rows
    .filter((row) => Number(row?.ts || 0) > sinceTs)
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
    .map(mapRealtimeChange);

  const maxTs = changed.reduce((max, item) => Math.max(max, Number(item.ts || 0)), sinceTs);
  return { changed, maxTs };
}

async function hydrateHistoryFromApi(api, { conversationId, isGroup, count }) {
  const threadId = String(conversationId || '').trim();
  if (!threadId) return [];

  const strategies = [
    async () => (typeof api.getMessageHistory === 'function' ? api.getMessageHistory({ threadId, isGroup: Boolean(isGroup), count }) : null),
    async () => (typeof api.getHistoryMessage === 'function' ? api.getHistoryMessage({ groupId: threadId, count }) : null),
    async () => (typeof api.getCM === 'function' ? api.getCM({ groupId: threadId, globalMsgId: 0, count }) : null),
    async () => {
      if (!isGroup || typeof api.getRecentGroup !== 'function') return null;
      return api.getRecentGroup({ groupId: threadId, globalMsgId: 0, count });
    },
    async () => {
      if (isGroup || typeof api.getLastMsgs !== 'function') return null;
      return api.getLastMsgs(threadId, count);
    },
  ];

  for (const strategy of strategies) {
    try {
      const raw = await strategy();
      const normalized = mergeHistoryMessages(extractHistoryMessages(raw));
      if (normalized.length > 0) return normalized;
    } catch (_) {
      // ignore and try next strategy
    }
  }

  return [];
}

async function handleSendBatchStream(req, res, body) {
  const account = body?.account;
  const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
  const messageTemplates = Array.isArray(body?.messageTemplates) ? body.messageTemplates : [];
  const rotateMessageEvery = Math.max(1, parseInt(body?.rotateMessageEvery, 10) || 100);

  if (!account) {
    writeJson(res, 400, { ok: false, error: 'Thiếu account để gửi tin.' });
    return;
  }
  if (!jobs.length) {
    writeJson(res, 400, { ok: false, error: 'Danh sách jobs rỗng.' });
    return;
  }

  // Enrich account from DB if frontend sent incomplete session data
  try {
    const hasCookies = Boolean(
      (Array.isArray(account?.cookies) && account.cookies.length > 0) ||
      (typeof account?.cookie === 'string' && account.cookie.trim()),
    );
    if (!hasCookies && account.ownerUserId && (account.id || account.zaloId || account.userId)) {
      const zaloId = account.id || account.zaloId || account.userId;
      const dbAccount = await getAccount(account.ownerUserId, zaloId);
      if (dbAccount) {
        Object.assign(account, {
          cookie: dbAccount.cookie,
          cookies: dbAccount.cookies,
          imei: dbAccount.imei || account.imei,
          decryptKey: dbAccount.decryptKey || account.decryptKey,
          commonParams: dbAccount.commonParams || account.commonParams,
          UIN: dbAccount.UIN || account.UIN,
          sessionSource: dbAccount.sessionSource || account.sessionSource,
        });
      }
    }
  } catch (enrichErr) {
    console.warn('[backend] Account enrichment for messages/batch failed:', enrichErr.message);
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

  let clientClosed = false;
  req.on('close', () => {
    clientClosed = true;
  });

  // Convert base64 files to Buffer attachments (shared across all jobs)
  const rawFiles = Array.isArray(body?.files) ? body.files : [];
  const attachments = rawFiles
    .filter((f) => f && typeof f.name === 'string' && typeof f.data === 'string')
    .map((f) => {
      const buf = Buffer.from(f.data, 'base64');
      return { data: buf, filename: f.name, metadata: { totalSize: buf.length } };
    });

  let accepted = 0;
  let failed = 0;
  let templateIdx = 0;
  let templateCounter = 0;

  for (let index = 0; index < jobs.length; index += 1) {
    if (clientClosed || res.writableEnded) break;

    const job = jobs[index];
    const groupJob = isGroupJob(job);
    const zid = normalizeThreadId(job?.zid, groupJob);
    // Use rotating templates if provided, else job.content
    let content;
    if (messageTemplates.length > 0) {
      content = String(messageTemplates[templateIdx % messageTemplates.length] || '').trim();
    } else {
      content = String(job?.content || '').trim();
    }
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

      // Check if attachment uploads failed
      const attachResults = Array.isArray(apiResult?.attachment) ? apiResult.attachment : [];
      const attachFailed = hasAttachments && attachResults.length === 0;

      accepted++;
      try {
        const ownerUserId = String(account?.ownerUserId || '').trim();
        const accountZaloId = String(account?.id || account?.zaloId || account?.userId || '').trim();
        if (ownerUserId && accountZaloId) {
          const sendTs = Date.now();
          const sendMsgId = String(
            apiResult?.message?.msgId
            || apiResult?.message?.globalMsgId
            || apiResult?.message?.realMsgId
            || apiResult?.msgId
            || apiResult?.globalMsgId
            || `local_${sendTs}_${String(job?.id || zid)}`
          );

          await upsertMessageHistory({
            ownerUserId,
            accountZaloId,
            conversationId: zid,
            isGroup: groupJob,
            messages: [{
              msgId: sendMsgId,
              fromId: accountZaloId,
              toId: zid,
              content,
              rawContent: hasAttachments ? { attachments: true } : null,
              msgType: hasAttachments ? 'attachment' : 'text',
              ts: sendTs,
              dName: String(account?.displayName || account?.name || ''),
            }],
          });
        }
      } catch (dbErr) {
        console.warn('[backend] cache sent message failed:', dbErr.message);
      }

      writeNdjsonLine(res, {
        jobId: job.id, ok: true, status: 'sent',
        statusLabel: attachFailed ? 'Đã gửi (tệp lỗi)' : 'Đã gửi',
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

    templateCounter++;
    if (messageTemplates.length > 1 && templateCounter >= rotateMessageEvery) {
      templateIdx++;
      templateCounter = 0;
    }

    if (index < jobs.length - 1) {
      if (clientClosed || res.writableEnded) break;
      const delayMs = getDelayMs(job?.delayWindow);
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  if (!clientClosed && !res.writableEnded) {
    writeNdjsonLine(res, { _done: true, ok: true, accepted, failed });
    res.end();
  }
}

async function handleFriendRequestBatchStream(req, res, body) {
  const account = body?.account;
  const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
  const messageTemplates = Array.isArray(body?.messageTemplates) ? body.messageTemplates : [];
  const rotateMessageEvery = Math.max(1, parseInt(body?.rotateMessageEvery, 10) || 100);

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

  ensureCustomApiActions(api);

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache',
  });

  let clientClosed = false;
  req.on('close', () => {
    clientClosed = true;
  });

  let accepted = 0;
  let failed = 0;
  let templateIdx = 0;
  let templateCounter = 0;

  for (let index = 0; index < jobs.length; index += 1) {
    if (clientClosed || res.writableEnded) break;

    const job = jobs[index];
    const userId = String(job?.zid || '').trim();
    // Use rotating templates if provided, else job.note
    let note;
    if (messageTemplates.length > 0) {
      note = String(messageTemplates[templateIdx % messageTemplates.length] || '').trim();
    } else {
      note = String(job?.note || '').trim();
    }
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

    templateCounter++;
    if (messageTemplates.length > 1 && templateCounter >= rotateMessageEvery) {
      templateIdx++;
      templateCounter = 0;
    }

    if (index < jobs.length - 1) {
      if (clientClosed || res.writableEnded) break;
      const delayMs = getDelayMs(job?.delayWindow);
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  if (!clientClosed && !res.writableEnded) {
    writeNdjsonLine(res, { _done: true, ok: true, accepted, failed });
    res.end();
  }
}

// ─── Rotation: round-robin friend requests across multiple accounts ─────
async function handleFriendRequestRotateStream(req, res, body) {
  const rotationAccounts = Array.isArray(body?.accounts) ? body.accounts : [];
  const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
  const batchSize = Math.max(1, parseInt(body?.batchSize, 10) || 100);
  const messageTemplates = Array.isArray(body?.messageTemplates) ? body.messageTemplates : [];
  const rotateMessageEvery = Math.max(1, parseInt(body?.rotateMessageEvery, 10) || 100);

  if (!rotationAccounts.length || rotationAccounts.length < 2) {
    writeJson(res, 400, { ok: false, error: 'Cần ít nhất 2 tài khoản để luân phiên.' });
    return;
  }
  if (!jobs.length) {
    writeJson(res, 400, { ok: false, error: 'Danh sách job kết bạn rỗng.' });
    return;
  }

  const userAgent = getUserAgent(body, req);

  // Create API clients for each account
  const clients = [];
  for (let i = 0; i < rotationAccounts.length; i++) {
    const acct = rotationAccounts[i];
    try {
      const { api } = await createApiClient(acct, userAgent);
      clients.push({ api, account: acct, label: acct.name || acct.phone || `Nick ${i + 1}`, index: i });
    } catch (error) {
      // Skip accounts that can't be initialized; report once streaming starts
      clients.push({ api: null, account: acct, label: acct.name || acct.phone || `Nick ${i + 1}`, index: i, error: error?.message || 'Khởi tạo thất bại' });
    }
  }

  const liveClients = clients.filter((c) => c.api);
  if (!liveClients.length) {
    writeJson(res, 500, { ok: false, error: 'Không thể khởi tạo phiên Zalo cho bất kỳ tài khoản nào.' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache',
  });

  let clientClosed = false;
  req.on('close', () => {
    clientClosed = true;
  });

  // Report failed account initializations
  for (const c of clients) {
    if (!c.api) {
      writeNdjsonLine(res, { _accountError: true, accountIndex: c.index, accountLabel: c.label, error: c.error });
    }
  }

  let accepted = 0;
  let failed = 0;
  let clientIdx = 0;
  let batchCounter = 0; // requests sent by current account in this batch
  let templateIdx = 0;
  let templateCounter = 0; // requests since last message rotation

  for (let index = 0; index < jobs.length; index += 1) {
    if (clientClosed || res.writableEnded) break;

    const job = jobs[index];
    const userId = String(job?.zid || '').trim();

    // Pick the current note — use rotating templates if provided, else job.note
    let note;
    if (messageTemplates.length > 0) {
      note = String(messageTemplates[templateIdx % messageTemplates.length] || '').trim();
    } else {
      note = String(job?.note || '').trim();
    }

    const client = liveClients[clientIdx % liveClients.length];
    const startedAt = new Date().toISOString();

    writeNdjsonLine(res, {
      jobId: job.id,
      status: 'running',
      statusLabel: `[${client.label}] Đang kết bạn ${index + 1}/${jobs.length}`,
      startedAt,
      provider: 'server',
      accountIndex: client.index,
      accountLabel: client.label,
    });

    if (!userId || userId === '—') {
      failed++;
      writeNdjsonLine(res, {
        jobId: job?.id, ok: false, status: 'failed',
        statusLabel: 'Thiếu Zalo ID',
        error: 'Job không có Zalo ID hợp lệ.',
        startedAt, failedAt: new Date().toISOString(), provider: 'server',
        accountIndex: client.index, accountLabel: client.label,
      });
    } else {
      try {
        const apiResult = await client.api.sendFriendRequest(note, userId);
        accepted++;
        writeNdjsonLine(res, {
          jobId: job.id, ok: true, status: 'sent',
          statusLabel: `[${client.label}] Đã gửi lời mời`,
          startedAt, sentAt: new Date().toISOString(), provider: 'server',
          apiResult, accountIndex: client.index, accountLabel: client.label,
        });
      } catch (error) {
        const code = typeof error?.code === 'number' ? error.code : null;
        if (code === 222) {
          accepted++;
          writeNdjsonLine(res, {
            jobId: job.id, ok: true, status: 'accepted',
            statusLabel: `[${client.label}] Đã chấp nhận lời mời`,
            startedAt, sentAt: new Date().toISOString(), provider: 'server',
            accountIndex: client.index, accountLabel: client.label,
          });
        } else if (code === 225) {
          accepted++;
          writeNdjsonLine(res, {
            jobId: job.id, ok: true, status: 'skipped',
            statusLabel: `[${client.label}] Đã là bạn bè`,
            startedAt, sentAt: new Date().toISOString(), provider: 'server',
            accountIndex: client.index, accountLabel: client.label,
          });
        } else {
          failed++;
          writeNdjsonLine(res, {
            jobId: job?.id, ok: false, status: 'failed',
            statusLabel: `[${client.label}] Kết bạn thất bại`,
            error: error instanceof Error ? error.message : 'Gửi lời mời kết bạn thất bại.',
            startedAt, failedAt: new Date().toISOString(), provider: 'server',
            accountIndex: client.index, accountLabel: client.label,
          });
        }
      }
    }

    batchCounter++;
    templateCounter++;

    // Rotate message template
    if (messageTemplates.length > 1 && templateCounter >= rotateMessageEvery) {
      templateIdx++;
      templateCounter = 0;
    }

    // Rotate to next account after batchSize requests
    if (batchCounter >= batchSize) {
      clientIdx++;
      batchCounter = 0;

      // Extra delay between account switches
      writeNdjsonLine(res, {
        _rotationSwitch: true,
        fromAccount: client.label,
        toAccount: liveClients[(clientIdx) % liveClients.length]?.label,
        sentSoFar: index + 1,
        remaining: jobs.length - index - 1,
      });
    }

    if (index < jobs.length - 1) {
      if (clientClosed || res.writableEnded) break;
      const delayMs = getDelayMs(job?.delayWindow);
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  if (!clientClosed && !res.writableEnded) {
    writeNdjsonLine(res, { _done: true, ok: true, accepted, failed, rotationAccountCount: liveClients.length });
    res.end();
  }
}

async function handleActionBatchStream(req, res, body) {
  const account = body?.account;
  const jobs = Array.isArray(body?.jobs) ? body.jobs : [];

  if (!account) {
    writeJson(res, 400, { ok: false, error: 'Thiếu account để thực thi thao tác.' });
    return;
  }
  if (!jobs.length) {
    writeJson(res, 400, { ok: false, error: 'Danh sách thao tác rỗng.' });
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

  ensureCustomApiActions(api);

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache',
  });

  let clientClosed = false;
  req.on('close', () => {
    clientClosed = true;
  });

  let accepted = 0;
  let failed = 0;

  const ACTION_LABELS = {
    remove_friend: { running: 'Đang xóa bạn', ok: 'Đã xóa bạn', fail: 'Xóa bạn thất bại' },
    leave_group: { running: 'Đang rời nhóm', ok: 'Đã rời nhóm', fail: 'Rời nhóm thất bại' },
    undo_friend_request: { running: 'Đang thu hồi lời mời', ok: 'Đã thu hồi lời mời', fail: 'Thu hồi lời mời thất bại' },
    accept_friend_request: { running: 'Đang chấp nhận lời mời', ok: 'Đã chấp nhận lời mời', fail: 'Chấp nhận lời mời thất bại' },
    reject_friend_request: { running: 'Đang từ chối lời mời', ok: 'Đã từ chối lời mời', fail: 'Từ chối lời mời thất bại' },
    pull_group: { running: 'Đang mời vào nhóm', ok: 'Đã mời vào nhóm', fail: 'Kéo nhóm thất bại' },
    join_group: { running: 'Đang tham gia nhóm', ok: 'Đã tham gia nhóm', fail: 'Tham gia nhóm thất bại' },
    mute: { running: 'Đang tắt thông báo', ok: 'Đã tắt thông báo', fail: 'Tắt thông báo thất bại' },
    unmute: { running: 'Đang bật thông báo', ok: 'Đã bật thông báo', fail: 'Bật thông báo thất bại' },
  };

  for (let index = 0; index < jobs.length; index += 1) {
    if (clientClosed || res.writableEnded) break;

    const job = jobs[index];
    const actionType = String(job?.actionType || '').trim();
    const groupJob = isGroupJob(job);
    const zid = normalizeThreadId(job?.zid, groupJob);
    const startedAt = new Date().toISOString();
    const labels = ACTION_LABELS[actionType] || { running: 'Đang xử lý', ok: 'Hoàn tất', fail: 'Thất bại' };
    const itemName = job?.name || job?.zid || '';

    writeNdjsonLine(res, {
      jobId: job.id,
      status: 'running',
      statusLabel: `${labels.running} ${index + 1}/${jobs.length}${itemName ? ': ' + itemName : ''}`,
      startedAt,
      provider: 'server',
    });

    if (!zid || zid === '—') {
      failed++;
      writeNdjsonLine(res, {
        jobId: job?.id, ok: false, status: 'failed',
        statusLabel: 'Thiếu Zalo ID',
        error: 'Không tìm thấy Zalo ID hợp lệ.',
        startedAt, failedAt: new Date().toISOString(), provider: 'server',
      });
      continue;
    }

    try {
      let apiResult;
      let statusLabel = labels.ok;

      if (actionType === 'remove_friend') {
        if (groupJob) throw new Error('Xóa bạn bè không áp dụng cho nhóm.');
        apiResult = await api.removeFriend(zid);
      } else if (actionType === 'leave_group') {
        if (!groupJob) throw new Error('Rời nhóm chỉ áp dụng cho hội thoại nhóm.');
        apiResult = await api.leaveGroup(zid);
        const memberErrors = Array.isArray(apiResult?.memberError) ? apiResult.memberError : [];
        if (memberErrors.includes(zid)) throw new Error('Zalo từ chối thao tác rời nhóm.');
      } else if (actionType === 'undo_friend_request') {
        if (groupJob) throw new Error('Thu hồi lời mời không áp dụng cho nhóm.');
        apiResult = await api.undoFriendRequest(zid);
      } else if (actionType === 'accept_friend_request') {
        if (groupJob) throw new Error('Chấp nhận lời mời không áp dụng cho nhóm.');
        apiResult = await api.acceptFriendRequest(zid);
      } else if (actionType === 'reject_friend_request') {
        if (groupJob) throw new Error('Từ chối lời mời không áp dụng cho nhóm.');
        apiResult = await api.rejectFriendRequest(zid);
      } else if (actionType === 'pull_group') {
        if (groupJob) throw new Error('Kéo nhóm không áp dụng cho hội thoại nhóm.');
        const targetGroupId = normalizeThreadId(job?.targetGroupId, true);
        if (!targetGroupId || targetGroupId === '—') throw new Error('Chưa chọn nhóm đích.');
        apiResult = await api.addUserToGroup(zid, targetGroupId);
        const errorMembers = Array.isArray(apiResult?.errorMembers) ? apiResult.errorMembers : [];
        if (errorMembers.includes(zid)) {
          throw new Error(apiResult?.error_data?.[zid]?.[0] || 'Không thể mời vào nhóm.');
        }
        statusLabel = `Đã mời vào ${job?.targetGroupName || 'nhóm'}`;
      } else if (actionType === 'join_group') {
        const inviteLink = String(job?.inviteLink || job?.link || '').trim();
        if (!inviteLink) throw new Error('Không tìm thấy link mời nhóm.');
        try {
          apiResult = await api.joinGroupLink(inviteLink);
        } catch (err) {
          const code = typeof err?.code === 'number' ? err.code : null;
          if (code === 178) {
            accepted++;
            writeNdjsonLine(res, {
              jobId: job.id, ok: true, status: 'skipped',
              statusLabel: 'Đã ở trong nhóm',
              startedAt, sentAt: new Date().toISOString(), provider: 'server',
            });
            if (index < jobs.length - 1) {
              const delayMs = getDelayMs(job?.delayWindow);
              if (delayMs > 0) await sleep(delayMs);
            }
            continue;
          } else if (code === 240) {
            accepted++;
            writeNdjsonLine(res, {
              jobId: job.id, ok: true, status: 'pending',
              statusLabel: 'Đã gửi yêu cầu vào nhóm',
              startedAt, sentAt: new Date().toISOString(), provider: 'server',
            });
            if (index < jobs.length - 1) {
              const delayMs = getDelayMs(job?.delayWindow);
              if (delayMs > 0) await sleep(delayMs);
            }
            continue;
          }
          throw err;
        }
      } else if (actionType === 'mute' || actionType === 'unmute') {
        const threadType = groupJob ? ThreadType.Group : ThreadType.User;
        const params = actionType === 'mute'
          ? { action: MuteAction.MUTE, duration: MuteDuration.FOREVER }
          : { action: MuteAction.UNMUTE };
        apiResult = await api.setMute(params, zid, threadType);
      } else {
        throw new Error(`Action không được hỗ trợ: ${actionType || 'unknown'}.`);
      }

      accepted++;
      writeNdjsonLine(res, {
        jobId: job.id, ok: true, status: 'completed',
        statusLabel: `${statusLabel}${itemName ? ': ' + itemName : ''}`,
        startedAt, sentAt: new Date().toISOString(), provider: 'server',
        apiResult,
      });
    } catch (error) {
      failed++;
      writeNdjsonLine(res, {
        jobId: job?.id, ok: false, status: 'failed',
        statusLabel: `${labels.fail}${itemName ? ': ' + itemName : ''}`,
        error: error instanceof Error ? error.message : 'Thực thi thao tác thất bại.',
        startedAt, failedAt: new Date().toISOString(), provider: 'server',
      });
    }

    if (index < jobs.length - 1) {
      if (clientClosed || res.writableEnded) break;
      const delayMs = getDelayMs(job?.delayWindow);
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  if (!clientClosed && !res.writableEnded) {
    writeNdjsonLine(res, { _done: true, ok: true, accepted, failed });
    res.end();
  }
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

// ─── Process-level crash guards ─────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[backend] uncaughtException (kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[backend] unhandledRejection (kept alive):', reason);
});

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
  'https://zaloautofrontend.onrender.com',
  'https://autozalo-frontend.onrender.com',
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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-AutoZalo-Auth-Type, X-User-Agent');
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

      // ─── Session token exchange ───────────────────
      // Frontend sends a short-lived Google token, gets back a long-lived session token (30 days).
      if (req.method === 'POST' && url === '/api/auth/session') {
        const body = await readBody(req);
        const googleToken = body?.googleToken || '';
        const googleAuthType = body?.googleAuthType || 'google-id-token';

        if (!googleToken) {
          return writeJson(res, 400, { ok: false, error: 'Thiếu googleToken.' });
        }

        try {
          const principal = googleAuthType === 'google-access-token'
            ? await verifyGoogleAccessToken(googleToken)
            : await verifyGoogleIdToken(googleToken);

          const session = createSessionToken(principal.sub, principal.email);
          return writeJson(res, 200, {
            ok: true,
            sessionToken: session.token,
            expiresAt: session.expiresAt,
            sub: principal.sub,
            email: principal.email,
          });
        } catch (error) {
          return writeJson(res, 401, {
            ok: false,
            error: error instanceof Error ? error.message : 'Xác thực Google thất bại.',
          });
        }
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

      // ─── Notification routes ─────────────────────

      const notifMatch = url.match(/^\/api\/notifications\/([^/]+)$/);
      if (req.method === 'GET' && notifMatch) {
        const userId = decodeURIComponent(notifMatch[1]);
        const notifications = await getNotifications(userId);
        const unread = await getUnreadCount(userId);
        return writeJson(res, 200, { ok: true, notifications, unread });
      }

      const notifCountMatch = url.match(/^\/api\/notifications\/([^/]+)\/count$/);
      if (req.method === 'GET' && notifCountMatch) {
        const userId = decodeURIComponent(notifCountMatch[1]);
        const unread = await getUnreadCount(userId);
        return writeJson(res, 200, { ok: true, unread });
      }

      if (req.method === 'POST' && url === '/api/notifications/read-all') {
        const body = await readBody(req);
        if (!body?.userId) return writeJson(res, 400, { ok: false, error: 'Thiếu userId.' });
        await markAllRead(body.userId);
        return writeJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url === '/api/notifications/read') {
        const body = await readBody(req);
        if (!body?.userId || !body?.id) return writeJson(res, 400, { ok: false, error: 'Thiếu userId hoặc id.' });
        await markRead(body.userId, body.id);
        return writeJson(res, 200, { ok: true });
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

      if (req.method === 'GET' && url === '/api/admin/guide-content') {
        return handleAdminGetGuideContent(req, res);
      }

      if (req.method === 'PUT' && url === '/api/admin/guide-content') {
        const body = await readBody(req);
        return handleAdminUpdateGuideContent(req, res, body);
      }

      if (req.method === 'POST' && url === '/api/admin/grant-subscription') {
        const body = await readBody(req);
        return handleAdminGrantSubscription(req, res, body);
      }

      // ─── Group Library Admin ───

      if (req.method === 'GET' && url === '/api/admin/group-library/stats') {
        return handleAdminGroupLibraryStats(req, res);
      }

      if (req.method === 'GET' && url === '/api/admin/group-library/categories') {
        return handleAdminListCategories(req, res);
      }

      if (req.method === 'POST' && url === '/api/admin/group-library/categories') {
        const body = await readBody(req);
        return handleAdminCreateCategory(req, res, body);
      }

      if (req.method === 'PUT' && url === '/api/admin/group-library/categories') {
        const body = await readBody(req);
        return handleAdminUpdateCategory(req, res, body);
      }

      if (req.method === 'DELETE' && url === '/api/admin/group-library/categories') {
        const body = await readBody(req);
        return handleAdminDeleteCategory(req, res, body);
      }

      if (req.method === 'GET' && url === '/api/admin/group-library/groups') {
        const categoryId = fullUrl.searchParams.get('categoryId') || undefined;
        const search = fullUrl.searchParams.get('search') || undefined;
        return handleAdminListGroups(req, res, { categoryId, search });
      }

      if (req.method === 'POST' && url === '/api/admin/group-library/groups') {
        const body = await readBody(req);
        return handleAdminBulkAddGroups(req, res, body);
      }

      if (req.method === 'PUT' && url === '/api/admin/group-library/groups') {
        const body = await readBody(req);
        return handleAdminUpdateGroup(req, res, body);
      }

      if (req.method === 'DELETE' && url === '/api/admin/group-library/groups') {
        const body = await readBody(req);
        return handleAdminDeleteGroup(req, res, body);
      }

      // ─── Public Group Library ───

      if (req.method === 'GET' && url === '/api/group-library/categories') {
        const categories = await publicListCategories();
        return writeJson(res, 200, { ok: true, categories });
      }

      if (req.method === 'GET' && url === '/api/group-library/groups') {
        const categoryId = fullUrl.searchParams.get('categoryId') || undefined;
        const search = fullUrl.searchParams.get('search') || undefined;
        const groups = await publicListGroups({ categoryId, search });
        return writeJson(res, 200, { ok: true, groups });
      }

      if (req.method === 'GET' && url === '/api/guide/content') {
        const guide = await getGuideContent();
        return writeJson(res, 200, { ok: true, guide });
      }

      // ─── Zalo account tracking (server-side limit enforcement) ───

      // GET /api/accounts?userId=xxx — list registered Zalo accounts
      if (req.method === 'GET' && url === '/api/accounts') {
        const userId = fullUrl.searchParams.get('userId');
        if (!userId) return writeJson(res, 400, { ok: false, error: 'Thiếu userId.' });
        const principal = await requireAuthenticatedGoogleUser(req, res, userId);
        if (!principal) return;
        const accounts = await getAccountsByUser(userId);
        return writeJson(res, 200, { ok: true, accounts });
      }

      // POST /api/accounts/register — register a Zalo account for a user
      if (req.method === 'POST' && url === '/api/accounts/register') {
        const body = await readBody(req);
        const { userId, zaloId, zaloName, zaloAvatar, zaloPhone, accountData } = body || {};
        if (!userId || !zaloId) return writeJson(res, 400, { ok: false, error: 'Thiếu userId hoặc zaloId.' });
        const principal = await requireAuthenticatedGoogleUser(req, res, userId);
        if (!principal) return;
        // Look up actual subscription server-side — don't trust client planKey
        const { getSubscription } = await import('./lib/paymentStore.js');
        const sub = await getSubscription(userId);
        const planKey = (sub?.status === 'active' ? sub.planKey : null) || 'free';
        const result = await registerAccount({ userId, planKey, zaloId, zaloName, zaloAvatar, zaloPhone, accountData });
        return writeJson(res, result.ok ? 200 : 403, result);
      }

      // POST /api/accounts/remove — remove a Zalo account
      if (req.method === 'POST' && url === '/api/accounts/remove') {
        const body = await readBody(req);
        const { userId, zaloId } = body || {};
        if (!userId || !zaloId) return writeJson(res, 400, { ok: false, error: 'Thiếu userId hoặc zaloId.' });
        const principal = await requireAuthenticatedGoogleUser(req, res, userId);
        if (!principal) return;
        const removed = await removeAccount(userId, zaloId);
        return writeJson(res, 200, { ok: true, removed });
      }

      // ─── Zalo API proxy routes (uses zalo-api-final) ───

      // POST /api/zalo/account/ping — lightweight cookie validity check
      if (req.method === 'POST' && url === '/api/zalo/account/ping') {
        const body = await readBody(req);
        let account = body?.account;
        if (!account) {
          return writeJson(res, 400, { ok: false, error: 'Thiếu account.' });
        }

        // Enrich account from DB if needed
        try {
          const hasCookies = Boolean(
            (Array.isArray(account?.cookies) && account.cookies.length > 0) ||
            (typeof account?.cookie === 'string' && account.cookie.trim()),
          );
          if (!hasCookies && account.ownerUserId && (account.id || account.zaloId || account.userId)) {
            const zaloId = account.id || account.zaloId || account.userId;
            const dbAccount = await getAccount(account.ownerUserId, zaloId);
            if (dbAccount) {
              account = { ...dbAccount, ...account, cookie: dbAccount.cookie, cookies: dbAccount.cookies, imei: dbAccount.imei || account.imei };
            }
          }
        } catch { /* ignore enrichment failure */ }

        const userAgent = getUserAgent(body, req);
        try {
          const { api } = await createApiClient(account, userAgent);
          const profile = await api.fetchAccountInfo();
          return writeJson(res, 200, {
            ok: true,
            valid: true,
            profile: {
              name: profile?.name || profile?.displayName || '',
              avatar: profile?.avatar || '',
            },
          });
        } catch (error) {
          return writeJson(res, 200, {
            ok: true,
            valid: false,
            error: error instanceof Error ? error.message : 'Phiên Zalo đã hết hạn.',
          });
        }
      }

      if (req.method === 'POST' && url === '/api/zalo/account/sync') {
        const body = await readBody(req);
        // Enrich account from DB if frontend sent incomplete session data
        try {
          const acct = body?.account;
          const hasCookies = Boolean(
            (Array.isArray(acct?.cookies) && acct.cookies.length > 0) ||
            (typeof acct?.cookie === 'string' && acct.cookie.trim()),
          );
          if (acct && !hasCookies && acct.ownerUserId && (acct.id || acct.zaloId || acct.userId)) {
            const zaloId = acct.id || acct.zaloId || acct.userId;
            const dbAccount = await getAccount(acct.ownerUserId, zaloId);
            if (dbAccount) {
              body.account = { ...dbAccount, ...acct, cookie: dbAccount.cookie, cookies: dbAccount.cookies, imei: dbAccount.imei || acct.imei, decryptKey: dbAccount.decryptKey || acct.decryptKey, commonParams: dbAccount.commonParams || acct.commonParams, UIN: dbAccount.UIN || acct.UIN, sessionSource: dbAccount.sessionSource || acct.sessionSource };
            }
          }
        } catch (enrichErr) {
          console.warn('[backend] Account enrichment for account/sync failed:', enrichErr.message);
        }
        return handleAccountSync(req, res, body);
      }

      // POST /api/zalo/conversations — get recent conversation list via Zalo HTTP API (no browser tab)
      if (req.method === 'POST' && url === '/api/zalo/conversations') {
        const body = await readBody(req);
        let account = body?.account;
        if (!account) return writeJson(res, 400, { ok: false, error: 'Thiếu account.' });

        // Enrich from DB if needed
        try {
          const hasCookies = Boolean(
            (Array.isArray(account?.cookies) && account.cookies.length > 0) ||
            (typeof account?.cookie === 'string' && account.cookie.trim()),
          );
          if (!hasCookies && account.ownerUserId && (account.id || account.zaloId || account.userId)) {
            const zaloId = account.id || account.zaloId || account.userId;
            const dbAccount = await getAccount(account.ownerUserId, zaloId);
            if (dbAccount) Object.assign(account, dbAccount);
          }
        } catch (_) {}

        const userAgent = getUserAgent(body, req);
        let api;
        try {
          ({ api } = await createApiClient(account, userAgent));
        } catch (error) {
          return writeJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : 'Không thể khởi tạo phiên Zalo.',
            code: 'SERVICE_LOGIN_FAILED',
          });
        }

        try {
          // Build conversation list from friends + groups (no browser tab needed)
          const [friendsResult, groupsResult] = await Promise.allSettled([
            api.getAllFriends(),
            api.getAllGroups(),
          ]);

          const friendsRaw = friendsResult.status === 'fulfilled' ? friendsResult.value : [];
          const friends = Array.isArray(friendsRaw)
            ? friendsRaw
            : (Array.isArray(friendsRaw?.friends) ? friendsRaw.friends : []);

          const groupsRaw = groupsResult.status === 'fulfilled' ? groupsResult.value : null;
          const groupIds = Object.keys(groupsRaw?.gridVerMap || {})
            .map((groupId) => normalizeThreadId(groupId, true))
            .filter(Boolean);

          const groups = [];
          for (const ids of chunk(groupIds, 200)) {
            if (!ids.length) continue;
            const info = await api.getGroupInfo(ids);
            groups.push(...summarizeGroupMap(info, new Set()));
          }

          // Normalize to conversation shape expected by frontend
          const friendConversations = friends.map((f) => ({
            id: String(f.userId || f.globalId || ''),
            rawId: String(f.userId || f.globalId || ''),
            displayName: f.displayName || f.zaloName || f.username || 'Không rõ tên',
            avatar: f.avatar || '',
            isGroup: false,
            userId: String(f.userId || ''),
            lastMsgTime: Number(f.updatedTime || f.actionTime || 0) || 0,
          })).filter((item) => item.id);

          const groupConversations = groups.map((g) => ({
            id: String(g.userId || g.groupId || ''),
            rawId: String(g.userId || g.groupId || ''),
            displayName: g.displayName || 'Nhóm không rõ tên',
            avatar: g.avatar || '',
            isGroup: true,
            memberCount: Number(g.totalMember || 0),
            lastMessage: String(g.lastMessage || g.lastMsg || g.desc || '').trim() || '',
            lastMsgTime: Number(g.updatedTime || g.actionTime || g.lastMsgTime || g.lastActionTime || 0) || 0,
          })).filter((item) => item.id);

          const ownerUserId = String(account?.ownerUserId || '').trim();
          const accountZaloId = String(account?.id || account?.zaloId || account?.userId || '').trim();
          const latestMessageRows = (ownerUserId && accountZaloId)
            ? await listLatestConversationMessages({ ownerUserId, accountZaloId, limit: 1000 }).catch(() => [])
            : [];

          const latestByConversation = new Map();
          for (const row of latestMessageRows) {
            const key = String(row.conversationId || '').trim();
            if (key && !latestByConversation.has(key)) latestByConversation.set(key, row);
          }

          const attachCachedPreview = (conversation) => {
            const key = String(conversation?.id || conversation?.rawId || '').trim();
            if (!key) return conversation;
            const latest = latestByConversation.get(key);
            if (!latest) return conversation;

            const nextLastMsgTime = Number(latest.ts || 0) || Number(conversation.lastMsgTime || 0) || 0;
            const nextPreview = String(latest.content || '').trim();
            return {
              ...conversation,
              lastMsgTime: nextLastMsgTime,
              lastMessage: nextPreview || conversation.lastMessage || '',
              lastSenderName: String(latest.dName || ''),
              lastSenderId: String(latest.fromId || ''),
              lastMsgId: String(latest.msgId || ''),
              lastMsgType: String(latest.msgType || 'text'),
            };
          };

          const data = [...friendConversations, ...groupConversations]
            .map(attachCachedPreview)
            .sort((a, b) => Number(b.lastMsgTime || 0) - Number(a.lastMsgTime || 0));

          return writeJson(res, 200, { ok: true, data });
        } catch (error) {
          return writeJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : 'Không lấy được danh sách hội thoại.',
          });
        }
      }

      // POST /api/zalo/history — DB-first message history with API hydration fallback
      if (req.method === 'POST' && url === '/api/zalo/history') {
        const body = await readBody(req);
        let account = body?.account;
        const conversationId = String(body?.threadId || body?.conversationId || '').trim();
        const isGroup = Boolean(body?.isGroup);
        const count = Math.max(1, Math.min(100, Number(body?.count) || 30));
        const forceHydrate = body?.forceHydrate === true;

        if (!account) return writeJson(res, 400, { ok: false, error: 'Thiếu account.' });
        if (!conversationId) return writeJson(res, 400, { ok: false, error: 'Thiếu conversationId/threadId.' });

        // Enrich from DB if frontend sent incomplete account session.
        try {
          const hasCookies = Boolean(
            (Array.isArray(account?.cookies) && account.cookies.length > 0) ||
            (typeof account?.cookie === 'string' && account.cookie.trim()),
          );
          if (!hasCookies && account.ownerUserId && (account.id || account.zaloId || account.userId)) {
            const zaloId = account.id || account.zaloId || account.userId;
            const dbAccount = await getAccount(account.ownerUserId, zaloId);
            if (dbAccount) Object.assign(account, dbAccount);
          }
        } catch (_) {}

        const ownerUserId = String(account?.ownerUserId || '').trim();
        const accountZaloId = String(account?.id || account?.zaloId || account?.userId || '').trim();

        let cachedMessages = [];
        if (ownerUserId && accountZaloId) {
          try {
            cachedMessages = await listMessageHistory({ ownerUserId, accountZaloId, conversationId, limit: count });
          } catch (dbError) {
            console.warn('[backend] listMessageHistory failed:', dbError.message);
          }
        }

        const hasEnoughCache = cachedMessages.length >= Math.min(count, 10);
        if (hasEnoughCache && !forceHydrate) {
          return writeJson(res, 200, { ok: true, data: cachedMessages, source: 'db' });
        }

        const userAgent = getUserAgent(body, req);
        let api;
        try {
          ({ api } = await createApiClient(account, userAgent));
          ensureCustomApiActions(api);
        } catch (error) {
          if (cachedMessages.length > 0) {
            return writeJson(res, 200, {
              ok: true,
              data: cachedMessages,
              source: 'db-fallback',
              warning: error instanceof Error ? error.message : 'Không thể hydrate từ API.',
            });
          }
          return writeJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : 'Không thể khởi tạo phiên Zalo.',
            code: 'SERVICE_LOGIN_FAILED',
          });
        }

        let hydratedMessages = [];
        try {
          hydratedMessages = await hydrateHistoryFromApi(api, { conversationId, isGroup, count });
        } catch (error) {
          console.warn('[backend] hydrateHistoryFromApi failed:', error.message);
        }

        const mergedMessages = mergeHistoryMessages(cachedMessages, hydratedMessages);

        if (ownerUserId && accountZaloId && hydratedMessages.length > 0) {
          try {
            await upsertMessageHistory({
              ownerUserId,
              accountZaloId,
              conversationId,
              isGroup,
              messages: hydratedMessages,
            });
          } catch (dbError) {
            console.warn('[backend] upsertMessageHistory failed:', dbError.message);
          }
        }

        if (mergedMessages.length === 0) {
          const fallbackMessage = {
            msgId: `seed_${conversationId}`,
            fromId: 'system',
            toId: conversationId,
            content: 'Chưa đọc được lịch sử cũ từ Zalo API. Tin nhắn mới phát sinh từ bây giờ sẽ hiển thị ngay tại đây.',
            rawContent: { type: 'system_notice', reason: 'history_empty' },
            ts: Date.now(),
            msgType: 'system',
            dName: 'Hệ thống',
          };
          return writeJson(res, 200, {
            ok: true,
            data: [fallbackMessage],
            source: 'empty-fallback',
          });
        }

        return writeJson(res, 200, {
          ok: true,
          data: mergedMessages,
          source: hydratedMessages.length > 0
            ? (cachedMessages.length > 0 ? 'db+api' : 'api')
            : (cachedMessages.length > 0 ? 'db' : 'empty'),
        });
      }

      // POST /api/zalo/realtime/changes — fast delta from backend cache (no extension required)
      if (req.method === 'POST' && url === '/api/zalo/realtime/changes') {
        const body = await readBody(req);
        const account = body?.account;
        const sinceTs = Math.max(0, Number(body?.sinceTs) || 0);

        if (!account) {
          return writeJson(res, 400, { ok: false, error: 'Thiếu account.' });
        }

        const ownerUserId = String(account?.ownerUserId || '').trim();
        const accountZaloId = String(account?.id || account?.zaloId || account?.userId || '').trim();
        if (!ownerUserId || !accountZaloId) {
          return writeJson(res, 400, { ok: false, error: 'Thiếu định danh tài khoản.' });
        }

        try {
          const { changed, maxTs } = await buildRealtimeChanges({ ownerUserId, accountZaloId, sinceTs });
          return writeJson(res, 200, {
            ok: true,
            sinceTs,
            maxTs,
            changed,
            serverTs: Date.now(),
          });
        } catch (error) {
          return writeJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : 'Không thể đọc cache realtime.',
          });
        }
      }

      // GET /api/zalo/realtime/stream — SSE stream for backend-only realtime updates
      if (req.method === 'GET' && url === '/api/zalo/realtime/stream') {
        const ownerUserId = String(fullUrl.searchParams.get('ownerUserId') || '').trim();
        const accountZaloId = String(
          fullUrl.searchParams.get('accountZaloId')
          || fullUrl.searchParams.get('zaloId')
          || fullUrl.searchParams.get('id')
          || ''
        ).trim();
        let cursorTs = Math.max(0, Number(fullUrl.searchParams.get('sinceTs') || 0));

        if (!ownerUserId || !accountZaloId) {
          return writeJson(res, 400, { ok: false, error: 'Thiếu ownerUserId/accountZaloId.' });
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        const sendEvent = (eventName, payload) => {
          res.write(`event: ${eventName}\n`);
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };

        sendEvent('ready', { ok: true, sinceTs: cursorTs, serverTs: Date.now() });

        const timer = setInterval(async () => {
          if (res.writableEnded || res.destroyed) return;
          try {
            const { changed, maxTs } = await buildRealtimeChanges({ ownerUserId, accountZaloId, sinceTs: cursorTs });
            cursorTs = Math.max(cursorTs, maxTs);

            if (changed.length > 0) {
              sendEvent('changes', {
                ok: true,
                changed,
                maxTs: cursorTs,
                serverTs: Date.now(),
              });
            } else {
              // Keep connection alive through intermediaries when no message delta.
              res.write(`: heartbeat ${Date.now()}\n\n`);
            }
          } catch (error) {
            sendEvent('error', {
              ok: false,
              error: error instanceof Error ? error.message : 'Lỗi realtime stream.',
            });
          }
        }, 2000);

        const close = () => {
          clearInterval(timer);
          if (!res.writableEnded) res.end();
        };

        req.on('close', close);
        req.on('error', close);
        return;
      }

      if (req.method === 'POST' && url === '/api/zalo/messages/batch') {
        const body = await readBody(req);
        return handleSendBatchStream(req, res, body);
      }

      if (req.method === 'POST' && url === '/api/zalo/friends/requests/batch') {
        const body = await readBody(req);
        return handleFriendRequestBatchStream(req, res, body);
      }

      if (req.method === 'POST' && url === '/api/zalo/friends/requests/batch/rotate') {
        const body = await readBody(req);
        // Enrich each rotation account from DB
        const rotAccounts = Array.isArray(body?.accounts) ? body.accounts : [];
        for (let ri = 0; ri < rotAccounts.length; ri++) {
          try {
            const acct = rotAccounts[ri];
            const hasCookies = Boolean(
              (Array.isArray(acct?.cookies) && acct.cookies.length > 0) ||
              (typeof acct?.cookie === 'string' && acct.cookie.trim()),
            );
            if (acct && !hasCookies && acct.ownerUserId && (acct.id || acct.zaloId || acct.userId)) {
              const zaloId = acct.id || acct.zaloId || acct.userId;
              const dbAccount = await getAccount(acct.ownerUserId, zaloId);
              if (dbAccount) {
                rotAccounts[ri] = { ...dbAccount, ...acct, cookie: dbAccount.cookie, cookies: dbAccount.cookies, imei: dbAccount.imei || acct.imei, decryptKey: dbAccount.decryptKey || acct.decryptKey, commonParams: dbAccount.commonParams || acct.commonParams, UIN: dbAccount.UIN || acct.UIN, sessionSource: dbAccount.sessionSource || acct.sessionSource };
              }
            }
          } catch (_) { /* skip enrichment errors */ }
        }
        body.accounts = rotAccounts;
        return handleFriendRequestRotateStream(req, res, body);
      }

      if (req.method === 'POST' && url === '/api/zalo/find-users') {
        const body = await readBody(req);
        // Enrich account from DB if frontend sent incomplete session data
        try {
          const acct = body?.account;
          const hasCookies = Boolean(
            (Array.isArray(acct?.cookies) && acct.cookies.length > 0) ||
            (typeof acct?.cookie === 'string' && acct.cookie.trim()),
          );
          if (acct && !hasCookies && acct.ownerUserId && (acct.id || acct.zaloId || acct.userId)) {
            const zaloId = acct.id || acct.zaloId || acct.userId;
            const dbAccount = await getAccount(acct.ownerUserId, zaloId);
            if (dbAccount) {
              body.account = { ...dbAccount, ...acct, cookie: dbAccount.cookie, cookies: dbAccount.cookies, imei: dbAccount.imei || acct.imei, decryptKey: dbAccount.decryptKey || acct.decryptKey, commonParams: dbAccount.commonParams || acct.commonParams, UIN: dbAccount.UIN || acct.UIN, sessionSource: dbAccount.sessionSource || acct.sessionSource };
            }
          }
        } catch (enrichErr) {
          console.warn('[backend] Account enrichment from DB failed (find-users):', enrichErr.message);
        }
        try {
          return await handleFindUser(req, res, body);
        } catch (handlerErr) {
          console.error('[backend] find-users handler crashed:', handlerErr);
          return writeJson(res, 500, { ok: false, error: handlerErr?.message || 'Lỗi tra cứu SĐT/ZID.' });
        }
      }

      if (req.method === 'POST' && url === '/api/zalo/groups/invite-targets') {
        const body = await readBody(req);
        // Enrich account from DB if frontend sent incomplete session data
        try {
          const acct = body?.account;
          const hasCookies = Boolean(
            (Array.isArray(acct?.cookies) && acct.cookies.length > 0) ||
            (typeof acct?.cookie === 'string' && acct.cookie.trim()),
          );
          if (acct && !hasCookies && acct.ownerUserId && (acct.id || acct.zaloId || acct.userId)) {
            const zaloId = acct.id || acct.zaloId || acct.userId;
            const dbAccount = await getAccount(acct.ownerUserId, zaloId);
            if (dbAccount) {
              body.account = { ...dbAccount, ...acct, cookie: dbAccount.cookie, cookies: dbAccount.cookies, imei: dbAccount.imei || acct.imei, decryptKey: dbAccount.decryptKey || acct.decryptKey, commonParams: dbAccount.commonParams || acct.commonParams, UIN: dbAccount.UIN || acct.UIN, sessionSource: dbAccount.sessionSource || acct.sessionSource };
            }
          }
        } catch (enrichErr) {
          console.warn('[backend] Account enrichment from DB failed:', enrichErr.message);
        }
        try {
          return await handleGroupInviteTargets(req, res, body);
        } catch (handlerErr) {
          console.error('[backend] invite-targets handler crashed:', handlerErr);
          return writeJson(res, 500, { ok: false, error: handlerErr?.message || 'Lỗi xử lý thành viên nhóm.' });
        }
      }

      if (req.method === 'POST' && url === '/api/zalo/actions/batch') {
        const body = await readBody(req);
        return handleActionBatchStream(req, res, body);
      }

      // ─── AI Rewrite (DeepSeek proxy) ───

      if (req.method === 'POST' && url === '/api/ai/rewrite') {
        const body = await readBody(req);
        const text = String(body?.text || '').trim();
        const target = body?.target || 'message'; // 'message' or 'friend'
        if (!text) return writeJson(res, 400, { ok: false, error: 'Thiếu nội dung để viết lại.' });
        const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
        if (!DEEPSEEK_API_KEY) return writeJson(res, 503, { ok: false, error: 'AI rewrite chưa được cấu hình (thiếu DEEPSEEK_API_KEY).' });
        const systemPrompt = target === 'friend'
          ? 'Bạn là trợ lý viết lại tin nhắn kết bạn Zalo. Hãy viết lại nội dung sau thành 3 phiên bản khác nhau: 1 bản lịch sự chuyên nghiệp, 1 bản thân thiện gần gũi, 1 bản ngắn gọn súc tích. Mỗi bản tối đa 150 ký tự. Trả về JSON array gồm 3 string, không giải thích thêm.'
          : target === 'rotation'
          ? 'Bạn là trợ lý tạo mẫu tin nhắn kết bạn Zalo để luân phiên sử dụng (chống spam). Dựa trên nội dung gốc, hãy tạo 5 phiên bản khác nhau nhưng cùng ý nghĩa: mỗi bản có cách diễn đạt, phong cách, cấu trúc câu khác nhau để tránh bị hệ thống phát hiện spam. Mỗi bản tối đa 150 ký tự. Trả về JSON array gồm 5 string, không giải thích thêm.'
          : target === 'message_rotation'
          ? 'Bạn là trợ lý tạo mẫu tin nhắn Zalo để luân phiên sử dụng (chống spam). Dựa trên nội dung gốc, hãy tạo 5 phiên bản khác nhau nhưng cùng ý nghĩa: mỗi bản có cách diễn đạt, phong cách, cấu trúc câu khác nhau để tránh bị hệ thống phát hiện spam. Trả về JSON array gồm 5 string, không giải thích thêm.'
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

  // Check for expiring subscriptions and send notifications (every 6 hours)
  ensureNotificationSchema().then(() => {
    checkExpiringSubscriptions().catch(() => {});
    setInterval(() => checkExpiringSubscriptions().catch(() => {}), 6 * 60 * 60 * 1000);
  }).catch(() => {});

  // Ensure group library tables exist
  ensureGroupLibrarySchema().catch(() => {});

  // Ensure guide content table exists
  ensureGuideContentSchema().catch(() => {});

  // Ensure message history cache table exists
  ensureMessageHistorySchema().catch(() => {});
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`[autozalo-backend] Port ${PORT} is already in use.`);
    process.exit(1);
  }
  console.error('[autozalo-backend] Failed to start:', error);
  process.exit(1);
});
