#!/usr/bin/env node
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { getAccount } from '../../backend/lib/accountStore.js';
import { createApiClient } from '../../service/lib/apiClient.js';
import { ensureCustomApiActions } from '../../service/lib/handlers.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
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

  const content =
    String(raw.content || '').trim() ||
    extractHistoryContent(raw.content) ||
    extractHistoryContent(raw.rawContent) ||
    extractHistoryContent(raw);

  return {
    msgId,
    fromId,
    toId,
    content,
    ts: normalizeHistoryTimestamp(raw.ts || raw.sendDttm || raw.createTime || raw.time || 0),
    msgType: String(raw.msgType || raw.type || 'text').trim() || 'text',
    dName: String(raw.dName || raw.senderName || raw.fromName || raw.displayName || '').trim(),
    raw,
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

function normalizeMessages(rawResult) {
  const seen = new Set();
  const messages = [];
  for (const raw of extractHistoryMessages(rawResult)) {
    const item = normalizeHistoryMessage(raw);
    if (!item || seen.has(item.msgId)) continue;
    seen.add(item.msgId);
    messages.push(item);
  }
  messages.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  return messages;
}

function printUsage() {
  console.log('Usage:');
  console.log('  DB mode:');
  console.log('    node tools/testing/test-group-chat-history.mjs --user <googleUserId> --zalo <zaloId> --thread <groupThreadId> [--count 30] [--backend http://127.0.0.1:3000]');
  console.log('  File mode (no DB required):');
  console.log('    node tools/testing/test-group-chat-history.mjs --account-file <path-to-account.json> --thread <groupThreadId> [--count 30] [--backend http://127.0.0.1:3000]');
}

async function loadAccountForTest({ ownerUserId, zaloId, accountFile }) {
  if (accountFile) {
    const raw = await readFile(accountFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid account file: expected a JSON object.');
    }
    return parsed;
  }

  if (!ownerUserId || !zaloId) {
    throw new Error('Missing --user/--zalo in DB mode.');
  }

  const account = await getAccount(ownerUserId, zaloId);
  if (!account) {
    throw new Error(`Account not found in DB for user=${ownerUserId}, zalo=${zaloId}`);
  }
  return account;
}

async function testBackendEndpoint({ backendBase, account, threadId, count }) {
  const payload = {
    account: {
      id: account.id,
      ownerUserId: account.ownerUserId,
      userId: account.userId,
      zaloId: account.zaloId || account.id,
      cookie: account.cookie,
      cookies: account.cookies,
      imei: account.imei,
      decryptKey: account.decryptKey,
      commonParams: account.commonParams,
      UIN: account.UIN,
      sessionSource: account.sessionSource,
      userAgent: account.userAgent,
    },
    conversationId: threadId,
    threadId,
    isGroup: true,
    count,
  };

  const startedAt = Date.now();
  const response = await fetch(`${backendBase}/api/zalo/history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    data = null;
  }

  const elapsedMs = Date.now() - startedAt;
  const rawMessages = Array.isArray(data?.messages) ? data.messages : [];
  const normalized = rawMessages
    .map((m) => normalizeHistoryMessage(m))
    .filter(Boolean)
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));

  return {
    source: 'backend:/api/zalo/history',
    ok: Boolean(response.ok && data?.ok),
    status: response.status,
    elapsedMs,
    messageCount: normalized.length,
    sample: normalized.slice(-3).map((m) => ({ msgId: m.msgId, ts: m.ts, content: m.content?.slice(0, 80) || '' })),
    error: data?.error || null,
    extra: {
      source: data?.source,
      hydrated: data?.hydrated,
      cached: data?.cached,
      total: data?.total,
    },
  };
}

async function runApiStrategy(label, fn) {
  const startedAt = Date.now();
  try {
    const raw = await fn();
    const messages = normalizeMessages(raw);
    return {
      source: label,
      ok: true,
      elapsedMs: Date.now() - startedAt,
      messageCount: messages.length,
      sample: messages.slice(-3).map((m) => ({ msgId: m.msgId, ts: m.ts, content: m.content?.slice(0, 80) || '' })),
      error: null,
    };
  } catch (error) {
    return {
      source: label,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      messageCount: 0,
      sample: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const accountFile = String(args['account-file'] || process.env.TEST_ACCOUNT_FILE || '').trim();
  const ownerUserId = String(args.user || process.env.TEST_OWNER_USER_ID || '').trim();
  const zaloId = String(args.zalo || process.env.TEST_ZALO_ID || '').trim();
  const threadId = String(args.thread || process.env.TEST_THREAD_ID || '').trim();
  const count = Math.max(1, Math.min(200, Number(args.count || process.env.TEST_HISTORY_COUNT || 30) || 30));
  const backendBase = String(args.backend || process.env.BACKEND_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');

  const dbMode = !accountFile;
  if (!threadId || (dbMode && (!ownerUserId || !zaloId))) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  console.log(`[test-group-chat-history] Loading account in ${dbMode ? 'DB mode' : 'file mode'}...`);
  let account;
  try {
    account = await loadAccountForTest({ ownerUserId, zaloId, accountFile });
  } catch (error) {
    console.error('[error]', error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  const hasCookies = Boolean(
    (Array.isArray(account.cookies) && account.cookies.length > 0) ||
    (typeof account.cookie === 'string' && account.cookie.trim())
  );
  console.log('[account]', {
    ownerUserId: account.ownerUserId || ownerUserId || '',
    zaloId: account.zaloId || account.id || account.userId || zaloId || '',
    id: account.id,
    syncStatus: account.syncStatus,
    hasImei: Boolean(account.imei),
    hasCookies,
  });

  if (!hasCookies) {
    console.warn('[warn] Account has no cookies. Direct API tests will likely fail unless backend can enrich from DB.');
  }

  const results = [];

  try {
    const backendResult = await testBackendEndpoint({ backendBase, account, threadId, count });
    results.push(backendResult);
  } catch (error) {
    results.push({
      source: 'backend:/api/zalo/history',
      ok: false,
      elapsedMs: 0,
      messageCount: 0,
      sample: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }

  console.log('[test-group-chat-history] Creating API client for direct strategy tests...');
  let api = null;
  try {
    ({ api } = await createApiClient(account, account.userAgent || 'Mozilla/5.0'));
    ensureCustomApiActions(api);
  } catch (error) {
    results.push({
      source: 'direct:createApiClient',
      ok: false,
      elapsedMs: 0,
      messageCount: 0,
      sample: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (api) {
    const strategies = [
      {
        label: 'direct:getGroupChatHistory(threadId,count)',
        run: async () => (typeof api.getGroupChatHistory === 'function' ? api.getGroupChatHistory({ groupId: threadId, count }) : Promise.reject(new Error('Method not found'))),
      },
      {
        label: 'direct:getMessageHistory(threadId,true,count)',
        run: async () => (typeof api.getMessageHistory === 'function' ? api.getMessageHistory({ threadId, isGroup: true, count }) : Promise.reject(new Error('Method not found'))),
      },
      {
        label: 'direct:getHistoryMessage(threadId,count)',
        run: async () => (typeof api.getHistoryMessage === 'function' ? api.getHistoryMessage({ groupId: threadId, count }) : Promise.reject(new Error('Method not found'))),
      },
      {
        label: 'direct:getCM(threadId,0,0,count,Date.now(),10000,{})',
        run: async () => (typeof api.getCM === 'function' ? api.getCM({ groupId: threadId, globalMsgId: 0, count }) : Promise.reject(new Error('Method not found'))),
      },
      {
        label: 'direct:getRecentGroup(threadId,0,count)',
        run: async () => (typeof api.getRecentGroup === 'function' ? api.getRecentGroup({ groupId: threadId, globalMsgId: 0, count }) : Promise.reject(new Error('Method not found'))),
      },
      {
        label: 'direct:syncCloudMsgFirstLogin([threadId],0)',
        run: async () => (typeof api.syncCloudMsgFirstLogin === 'function' ? api.syncCloudMsgFirstLogin({ groupIds: [threadId], nretry: 0 }) : Promise.reject(new Error('Method not found'))),
      },
      {
        label: 'direct:getCloudMessageJump(threadId,0,count,false)',
        run: async () => (typeof api.getCloudMessageJump === 'function' ? api.getCloudMessageJump({ groupId: threadId, globalMsgId: 0, count, isJump: false }) : Promise.reject(new Error('Method not found'))),
      },
    ];

    for (const strategy of strategies) {
      // Keep tests sequential so logs and rate limits remain predictable.
      // This is easier to debug than running all API calls in parallel.
      // Each strategy mirrors one possible implementation path.
      const result = await runApiStrategy(strategy.label, strategy.run);
      results.push(result);
    }
  }

  console.log('\n=== Group Chat History Test Report ===');
  for (const result of results) {
    const status = result.ok ? 'PASS' : 'FAIL';
    console.log(`- [${status}] ${result.source}`);
    console.log(`  elapsedMs=${result.elapsedMs} messageCount=${result.messageCount}`);
    if (result.error) console.log(`  error=${result.error}`);
    if (result.extra) console.log(`  extra=${JSON.stringify(result.extra)}`);
    if (Array.isArray(result.sample) && result.sample.length > 0) {
      console.log(`  sample=${JSON.stringify(result.sample)}`);
    }
  }

  const best = results
    .filter((r) => r.ok)
    .sort((a, b) => Number(b.messageCount || 0) - Number(a.messageCount || 0))[0];

  if (best) {
    console.log(`\n[summary] Best source: ${best.source} (${best.messageCount} messages)`);
  } else {
    console.log('\n[summary] No strategy returned message history. Session may be expired or account lacks access to this thread.');
    process.exitCode = 3;
  }
}

main().catch((error) => {
  console.error('[fatal]', error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 99;
});
