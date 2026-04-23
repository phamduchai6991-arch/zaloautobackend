/* AutoZalo Bridge — Background Service Worker
   Handles incognito window lifecycle, routes data between Zalo tabs and web app. */

let webAppTabs = new Set();   // Tab IDs of web app pages
let incognitoWindowId = null;  // Current incognito window
let pendingLoginTabId = null;  // Tab in incognito with chat.zalo.me
let closingWindowIds = new Set();
let pendingFinalizeTimer = null;
let pendingReextractTimer = null;
let pendingAutoConfirmTimer = null;
let pendingReextractCount = 0;
let lastKnownLoginData = null;
let messageActionTabId = null;
let messageActionManagedWindowId = null;
let activeMessageBatch = null;
let loginCompleted = false;    // Track whether login succeeded before window closes
let pendingAccountSync = null;
let syncState = {
  phase: 'idle',
  requestId: null,
  mode: 'add',
  summary: null,
  error: '',
  startedAt: null,
};
const AUTO_CONFIRM_DELAY_MS = 1500;

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileMatchPattern(pattern) {
  const match = String(pattern || '').match(/^(\*|https?|http):\/\/([^/]+)(\/.*)$/i);
  if (!match) return null;

  const schemePart = match[1];
  const hostPart = match[2];
  const pathPart = match[3];
  const scheme = schemePart === '*' ? 'https?' : escapeRegex(schemePart);
  let host = '';

  if (hostPart === '*') {
    host = '[^/]+?';
  } else if (hostPart.indexOf('*.') === 0) {
    host = '(?:[^./]+\\.)*' + escapeRegex(hostPart.slice(2));
  } else {
    host = escapeRegex(hostPart);
  }

  const port = '(?::\\d+)?';
  const path = escapeRegex(pathPart).replace(/\\\*/g, '.*');
  return new RegExp('^' + scheme + ':\\/\\/' + host + port + path + '$', 'i');
}

function getAllowedWebAppPatterns() {
  try {
    const manifest = chrome.runtime.getManifest();
    const hostPermissions = Array.isArray(manifest && manifest.host_permissions) ? manifest.host_permissions : [];
    return hostPermissions
      .filter((pattern) => /^https?:\/\//i.test(pattern) && !/zalo\.me/i.test(pattern))
      .map((pattern) => compileMatchPattern(pattern))
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

const TRUSTED_WEB_APP_PATTERNS = getAllowedWebAppPatterns();

function isTrustedWebAppUrl(url) {
  if (!url) return false;
  try {
    const normalizedUrl = new URL(url).href;
    return TRUSTED_WEB_APP_PATTERNS.some((regex) => regex.test(normalizedUrl));
  } catch (_) {
    return false;
  }
}

function isTrustedWebAppSender(sender) {
  if (!sender?.tab?.id) return false;
  // Tab already registered as web-app tab → trusted
  if (webAppTabs.has(sender.tab.id)) return true;
  const url = sender.tab.url || sender.url || sender.origin || '';
  return isTrustedWebAppUrl(url);
}

function assertTrustedWebAppSender(sender, actionLabel) {
  if (isTrustedWebAppSender(sender)) {
    return;
  }

  throw new Error((actionLabel || 'Yêu cầu từ web app') + ' chỉ được chấp nhận từ origin đã khai báo trong host_permissions của extension.');
}

function callbackToPromise(invoker) {
  return new Promise((resolve, reject) => {
    try {
      invoker((result) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(result);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function windowsCreate(options) {
  return callbackToPromise((done) => chrome.windows.create(options, done));
}

function windowsRemove(windowId) {
  return callbackToPromise((done) => chrome.windows.remove(windowId, done));
}

function windowsUpdate(windowId, updateInfo) {
  return callbackToPromise((done) => chrome.windows.update(windowId, updateInfo, done));
}

function cookiesGetAllCookieStores() {
  return callbackToPromise((done) => chrome.cookies.getAllCookieStores(done));
}

function cookiesGetAll(details) {
  return callbackToPromise((done) => chrome.cookies.getAll(details, done));
}

function tabsSendMessage(tabId, message) {
  return callbackToPromise((done) => chrome.tabs.sendMessage(tabId, message, done));
}

function tabsGet(tabId) {
  return callbackToPromise((done) => chrome.tabs.get(tabId, done));
}

function tabsQuery(queryInfo) {
  return callbackToPromise((done) => chrome.tabs.query(queryInfo, done));
}

function tabsCreate(createProperties) {
  return callbackToPromise((done) => chrome.tabs.create(createProperties, done));
}

function tabsUpdate(tabId, updateProperties) {
  return callbackToPromise((done) => chrome.tabs.update(tabId, updateProperties, done));
}

function cookiesSet(details) {
  return callbackToPromise((done) => chrome.cookies.set(details, done));
}

function cookiesRemove(details) {
  return callbackToPromise((done) => chrome.cookies.remove(details, done));
}

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== 'zalotool-web-bridge') {
    return;
  }

  port.onMessage.addListener(() => {
    // Keepalive channel for web-bridge.js. No-op by design.
  });
});

function clearPendingTimers() {
  if (pendingFinalizeTimer) {
    clearTimeout(pendingFinalizeTimer);
    pendingFinalizeTimer = null;
  }
  if (pendingReextractTimer) {
    clearTimeout(pendingReextractTimer);
    pendingReextractTimer = null;
  }
  if (pendingAutoConfirmTimer) {
    clearTimeout(pendingAutoConfirmTimer);
    pendingAutoConfirmTimer = null;
  }
}

function resetPendingSession() {
  clearPendingTimers();
  pendingReextractCount = 0;
  lastKnownLoginData = null;
  loginCompleted = false;
  pendingAccountSync = null;
}

function createSyncRequestId() {
  return 'sync_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function normalizeSyncMode(mode) {
  return mode === 'refresh' ? 'refresh' : 'add';
}

function buildAccountSummary(accountData) {
  const me = accountData?.me || {};
  const session = accountData?.session || {};
  const name = me.displayName || me.zaloName || me.name || 'Tài khoản Zalo';
  const userId = session.userId || me.userId || accountData?.userId || '';
  const phone = me.phoneNumber || accountData?.phone || '';

  return {
    accountId: String(userId || accountData?.accountId || '').trim(),
    name,
    avatar: me.avatar || '',
    phone,
    userId: String(userId || '').trim(),
    friendCount: Array.isArray(accountData?.friends) ? accountData.friends.length : 0,
    groupCount: Array.isArray(accountData?.groups) ? accountData.groups.length : 0,
  };
}

function getSyncStateSnapshot() {
  return {
    ...syncState,
    requiresConfirmation: syncState.phase === 'awaiting_sync_confirmation',
    timestamp: Date.now(),
  };
}

async function sendSyncStateToTab(tabId) {
  if (!tabId) return;
  try {
    await tabsSendMessage(tabId, {
      type: 'ZALOTOOL_SYNC_STATE',
      data: getSyncStateSnapshot(),
    });
  } catch (_) {
    // Ignore best-effort sync-state delivery failures.
  }
}

async function broadcastSyncState(phase, patch = {}) {
  syncState = {
    ...syncState,
    ...patch,
    phase,
  };
  await broadcastToWebApps('ZALOTOOL_SYNC_STATE', getSyncStateSnapshot());
}

async function resetSyncState(phase = 'idle', patch = {}) {
  pendingAccountSync = null;
  syncState = {
    phase,
    requestId: patch.requestId || null,
    mode: normalizeSyncMode(patch.mode || syncState.mode || 'add'),
    summary: patch.summary || null,
    error: patch.error || '',
    startedAt: patch.startedAt || null,
  };
  await broadcastToWebApps('ZALOTOOL_SYNC_STATE', getSyncStateSnapshot());
}

function isAccountReady(account) {
  if (!account) return false;
  if (typeof account.syncStatus === 'string') {
    return account.syncStatus === 'ready';
  }

  const hasCookies = Boolean(
    (Array.isArray(account.cookies) && account.cookies.length > 0) ||
    (typeof account.cookie === 'string' && account.cookie.trim()),
  );

  return Boolean(account.imei && hasCookies);
}

async function ensureAccountReady(account, actionLabel) {
  if (isAccountReady(account)) return;
  throw new Error(actionLabel + ' yêu cầu tài khoản đã đồng bộ hoàn tất với extension. Hãy làm mới tài khoản và xác nhận đồng bộ trước khi tiếp tục.');
}

async function stagePendingAccountSync(accountData, windowId) {
  const requestId = createSyncRequestId();
  const summary = buildAccountSummary(accountData);
  pendingAccountSync = {
    requestId,
    accountData,
    windowId: windowId ?? incognitoWindowId ?? null,
  };

  await broadcastSyncState('awaiting_sync_confirmation', {
    requestId,
    summary,
    error: '',
  });

  // Auto-confirm shortly after session capture so users do not need manual clicks.
  if (pendingAutoConfirmTimer) {
    clearTimeout(pendingAutoConfirmTimer);
  }

  pendingAutoConfirmTimer = setTimeout(async () => {
    pendingAutoConfirmTimer = null;

    if (!pendingAccountSync || pendingAccountSync.requestId !== requestId) {
      return;
    }

    try {
      await confirmAccountSync(requestId);
    } catch (error) {
      // Keep manual confirmation available when auto-confirm cannot complete.
      if (!pendingAccountSync || pendingAccountSync.requestId !== requestId) {
        return;
      }

      await broadcastSyncState('awaiting_sync_confirmation', {
        requestId,
        summary,
        error: 'Tự động đồng bộ chưa thành công. Bạn có thể bấm "Xác nhận đồng bộ" để thử lại.',
      });
    }
  }, AUTO_CONFIRM_DELAY_MS);
}

async function confirmAccountSync(requestId) {
  if (!pendingAccountSync || pendingAccountSync.requestId !== requestId) {
    throw new Error('Yêu cầu đồng bộ tài khoản đã hết hạn hoặc không còn tồn tại.');
  }

  await broadcastSyncState('syncing_account', {
    requestId,
    summary: buildAccountSummary(pendingAccountSync.accountData),
    error: '',
  });

  await broadcastAccountData(pendingAccountSync.accountData);

  const summary = buildAccountSummary(pendingAccountSync.accountData);
  pendingAccountSync = null;
  pendingLoginTabId = null;
  clearPendingTimers();
  await broadcastSyncState('ready', {
    requestId: null,
    summary,
    error: '',
  });

  return { ok: true, summary };
}

async function cancelAccountSync(requestId, reason) {
  if (!pendingAccountSync) {
    await resetSyncState('cancelled', {
      mode: syncState.mode,
      error: reason || 'Đã hủy đồng bộ tài khoản.',
    });
    return { ok: true };
  }

  if (requestId && pendingAccountSync.requestId !== requestId) {
    throw new Error('Yêu cầu đồng bộ tài khoản không khớp với phiên hiện tại.');
  }

  const targetWindowId = pendingAccountSync.windowId ?? incognitoWindowId;
  pendingAccountSync = null;
  await resetSyncState('cancelled', {
    mode: syncState.mode,
    error: reason || 'Đã hủy đồng bộ tài khoản.',
  });

  if (targetWindowId != null) {
    await closeIncognito(targetWindowId);
  }

  return { ok: true };
}

// ===== MESSAGE ROUTING =====
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  switch (message.type) {
    case 'ZALOTOOL_CHECK': {
      const trusted = isTrustedWebAppSender(sender);
      console.log('[BG] ZALOTOOL_CHECK sender:', sender?.tab?.url, 'trusted:', trusted);
      sendResponse({
        active: trusted,
        version: '1.0.0',
        error: trusted ? '' : 'Origin hiện tại chưa được extension cho phép hoặc extension chưa có Site access cho trang này.',
      });
      return false;
    }

    case 'WEB_BRIDGE_INIT': {
      const trusted = isTrustedWebAppSender(sender);
      console.log('[BG] WEB_BRIDGE_INIT sender:', sender?.tab?.url, 'trusted:', trusted);
      if (!trusted) {
        sendResponse({ ok: false, error: 'Origin hiện tại chưa được extension cho phép.' });
        return false;
      }
      if (sender.tab?.id) {
        webAppTabs.add(sender.tab.id);
        sendSyncStateToTab(sender.tab.id);
      }
      sendResponse({ ok: true });
      return false;
    }

    case 'OPEN_ZALO_LOGIN':
      try {
        assertTrustedWebAppSender(sender, 'Mở cửa sổ đăng nhập');
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
        return false;
      }
      openIncognitoForLogin(message.data).then(() => sendResponse({ ok: true }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true; // async

    case 'CLOSE_INCOGNITO':
      try {
        assertTrustedWebAppSender(sender, 'Đóng cửa sổ đăng nhập');
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
        return false;
      }
      closeIncognito().then(() => sendResponse({ ok: true }));
      return true;

    case 'CONFIRM_ACCOUNT_SYNC':
      try {
        assertTrustedWebAppSender(sender, 'Xác nhận đồng bộ tài khoản');
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
        return false;
      }
      confirmAccountSync(message.data?.requestId)
        .then((result) => sendResponse(result))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'CANCEL_ACCOUNT_SYNC':
      try {
        assertTrustedWebAppSender(sender, 'Hủy đồng bộ tài khoản');
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
        return false;
      }
      cancelAccountSync(message.data?.requestId, message.data?.reason)
        .then((result) => sendResponse(result))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'ZALO_DATA_READY':
      handleZaloData(message.data, sender).then(() => sendResponse({ ok: true }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'EXECUTE_MESSAGE_JOBS':
      try {
        assertTrustedWebAppSender(sender, 'Khởi chạy batch tin nhắn');
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
        return false;
      }
      startMessageBatch(message.data)
        .then((result) => sendResponse(result))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'STOP_MESSAGE_BATCH':
      try {
        assertTrustedWebAppSender(sender, 'Dừng batch tin nhắn');
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
        return false;
      }
      stopMessageBatch(message.data?.reason)
        .then((result) => sendResponse(result))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'Z_GET_COMMON_DATA':
      try {
        assertTrustedWebAppSender(sender, 'Lấy dữ liệu phiên Zalo');
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
        return false;
      }
      getZaloCommonData(message.data)
        .then((result) => sendResponse(result))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'Z_FETCH':
      try {
        assertTrustedWebAppSender(sender, 'Gọi Zalo bridge');
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
        return false;
      }
      forwardZaloApiRequest(message.data)
        .then((result) => sendResponse(result))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'ZALO_MESSAGE_JOB_EVENT':
      applyMessageBatchProgress(String(message.data?.jobId || ''), message.data?.changes?.status);
      broadcastToWebApps('ZALOTOOL_MESSAGE_JOB_UPDATE', message.data).then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'ZALO_INCOMING_MESSAGES':
      broadcastToWebApps('ZALO_INCOMING_MESSAGES', message.data).then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    default:
      return false;
  }
});

// ===== INCOGNITO WINDOW MANAGEMENT =====
async function openIncognitoForLogin(payload = {}) {
  const mode = normalizeSyncMode(payload?.mode);
  // Close existing incognito first (ensures clean session)
  await closeIncognito();
  await closeManagedMessageActionWindow();
  // Brief pause so Chrome clears the incognito session
  await delay(300);
  resetPendingSession();
  syncState = {
    phase: 'waiting_for_login',
    requestId: null,
    mode,
    summary: null,
    error: '',
    startedAt: Date.now(),
  };

  const win = await windowsCreate({
    url: 'https://chat.zalo.me/',
    incognito: true,
    focused: true,
    width: 1280,
    height: 800,
  });

  incognitoWindowId = win.id;
  pendingLoginTabId = win.tabs?.[0]?.id ?? null;
  console.log('[ZaloTool BG] Incognito opened, window:', win.id, 'tab:', pendingLoginTabId);
  await broadcastToWebApps('ZALOTOOL_SYNC_STATE', getSyncStateSnapshot());
  scheduleFallbackFinalize();
}

async function closeIncognito(targetWindowId) {
  const windowId = targetWindowId ?? incognitoWindowId;
  clearPendingTimers();

  if (pendingAccountSync && syncState.phase !== 'ready') {
    pendingAccountSync = null;
    await resetSyncState('cancelled', {
      mode: syncState.mode,
      error: 'Đã đóng phiên đăng nhập trước khi hoàn tất đồng bộ.',
    });
  }

  if (windowId != null) {
    closingWindowIds.add(windowId);
    try {
      await windowsRemove(windowId);
    } catch {}
    closingWindowIds.delete(windowId);
    if (incognitoWindowId === windowId) {
      incognitoWindowId = null;
      pendingLoginTabId = null;
    }
  }
}

function scheduleFallbackFinalize() {
  clearPendingTimers();
  pendingFinalizeTimer = setTimeout(() => {
    finalizePendingLogin('timeout').catch((error) => {
      console.warn('[ZaloTool BG] Fallback finalize failed:', error);
    });
  }, 30000);
}

function scheduleReextract(tabId, reason) {
  if (!tabId || tabId !== pendingLoginTabId) return;
  if (pendingReextractCount >= 4) return;

  if (pendingReextractTimer) {
    clearTimeout(pendingReextractTimer);
  }

  pendingReextractTimer = setTimeout(async () => {
    try {
      pendingReextractCount += 1;
      console.log('[ZaloTool BG] Requesting re-extract attempt', pendingReextractCount, 'reason:', reason);
      await tabsSendMessage(tabId, { type: 'ZALOTOOL_RE_EXTRACT' });
    } catch (error) {
      console.warn('[ZaloTool BG] Re-extract request failed:', error.message);
    }
  }, 4000);
}

async function readZaloCookiesForTab(tabId) {
  let cookieStr = '';
  let cookieCount = 0;
  let cookiesArr = [];

  try {
    const stores = await cookiesGetAllCookieStores();
    const senderStore = stores.find((store) => store.tabIds.includes(tabId));
    const storeId = senderStore?.id;

    const cookies = await cookiesGetAll({
      domain: '.zalo.me',
      ...(storeId ? { storeId } : {}),
    });

    cookieStr = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    cookieCount = cookies.length;
    cookiesArr = cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
      expirationDate: cookie.expirationDate,
      session: cookie.session,
    }));
  } catch (error) {
    console.warn('[ZaloTool BG] Cookie read error:', error);
  }

  return { cookieStr, cookieCount, cookiesArr };
}

async function broadcastAccountData(accountData) {
  await broadcastToWebApps('ZALOTOOL_ACCOUNT_DATA', accountData);
}

async function broadcastToWebApps(type, data) {
  // MV3 service workers lose in-memory state on idle restart.
  // Re-scan regular web tabs and try delivery again after wake-up.
  try {
    const allTabs = await tabsQuery({});
    for (const tab of allTabs) {
      if (!tab?.id || !tab.url) continue;
      if (isTrustedWebAppUrl(tab.url)) {
        webAppTabs.add(tab.id);
      } else {
        webAppTabs.delete(tab.id);
      }
    }
  } catch (_) {}

  for (const tabId of webAppTabs) {
    try {
      await tabsSendMessage(tabId, {
        type,
        data,
      });
    } catch {
      webAppTabs.delete(tabId);
    }
  }
}

async function broadcastMessageJobUpdate(jobId, changes) {
  if (!jobId || !changes) return;
  await broadcastToWebApps('ZALOTOOL_MESSAGE_JOB_UPDATE', {
    jobId,
    changes,
  });
}

async function failMessageJobs(jobs, errorMessage) {
  const message = errorMessage || 'Không thể khởi chạy batch gửi tin.';
  for (const job of jobs) {
    await broadcastMessageJobUpdate(job?.id, {
      status: 'failed',
      statusLabel: 'Không thể khởi chạy',
      error: message,
      failedAt: new Date().toISOString(),
    });
  }
}

function trackActiveMessageBatch(jobs, tabId) {
  const pendingJobIds = new Set(
    (Array.isArray(jobs) ? jobs : [])
      .map((job) => String(job?.id || '').trim())
      .filter(Boolean),
  );

  activeMessageBatch = {
    tabId,
    pendingJobIds,
    startedAt: Date.now(),
  };
}

function applyMessageBatchProgress(jobId, status) {
  if (!activeMessageBatch || !jobId) return;

  if (activeMessageBatch.pendingJobIds.has(jobId)) {
    const terminalStatuses = new Set(['sent', 'failed', 'completed', 'skipped', 'accepted', 'pending', 'stopped']);
    if (terminalStatuses.has(String(status || '').trim())) {
      activeMessageBatch.pendingJobIds.delete(jobId);
    }
  }

  if (activeMessageBatch.pendingJobIds.size === 0) {
    activeMessageBatch = null;
  }
}

async function stopMessageBatch(reason = 'Người dùng đã dừng batch.') {
  const batch = activeMessageBatch;
  if (!batch) {
    return { ok: true, stopped: 0, message: 'Không có batch nhắn tin nào đang chạy.' };
  }

  try {
    if (batch.tabId != null) {
      await tabsSendMessage(batch.tabId, { type: 'ZALOTOOL_STOP_MESSAGE_BATCH', data: { reason } });
    }
  } catch (_) {
    // Ignore transport errors and still update UI state below.
  }

  const remainingJobIds = Array.from(batch.pendingJobIds);
  for (const jobId of remainingJobIds) {
    await broadcastMessageJobUpdate(jobId, {
      status: 'stopped',
      statusLabel: 'Đã dừng',
      error: reason,
      failedAt: new Date().toISOString(),
    });
  }

  activeMessageBatch = null;
  return { ok: true, stopped: remainingJobIds.length };
}

async function finalizePendingLogin(reason) {
  if (!pendingLoginTabId) return;

  let tab = null;
  try {
    tab = await tabsGet(pendingLoginTabId);
  } catch (_) {
    tab = null;
  }

  const cookieData = await readZaloCookiesForTab(pendingLoginTabId);
  if (!cookieData.cookieCount) {
    console.log('[ZaloTool BG] Skip finalize without cookies, reason:', reason);
    scheduleFallbackFinalize();
    return;
  }

  const accountData = {
    ...(lastKnownLoginData || {}),
    me: lastKnownLoginData?.me || null,
    friends: Array.isArray(lastKnownLoginData?.friends) ? lastKnownLoginData.friends : [],
    groups: Array.isArray(lastKnownLoginData?.groups) ? lastKnownLoginData.groups : [],
    cookieCount: cookieData.cookieCount,
    cookies: cookieData.cookiesArr,
    timestamp: Date.now(),
    fallbackReason: reason,
    title: tab?.title || '',
    url: tab?.url || '',
  };

  console.log('[ZaloTool BG] Finalizing pending login with fallback, reason:', reason, 'cookies:', cookieData.cookieCount);
  loginCompleted = true;
  const windowId = tab?.windowId || incognitoWindowId;
  await stagePendingAccountSync(accountData, windowId);

  // Keep the login window alive as the action tab for this account.
  if (windowId) {
    try {
      await windowsUpdate(windowId, { state: 'minimized', focused: false });
      messageActionTabId = pendingLoginTabId;
      console.log('[ZaloTool BG] Incognito minimized, reused as action tab:', messageActionTabId);
    } catch (e) {
      await closeIncognito(windowId);
    }
  }
}

// ===== DATA HANDLING =====
async function handleZaloData(data, sender) {
  console.log('[ZaloTool BG] Data received from Zalo tab:', data?.name, 'friends:', data?.friends?.length);
  clearPendingTimers();
  lastKnownLoginData = data || null;

  // Read all Zalo cookies from the sender's cookie store
  const cookieData = await readZaloCookiesForTab(sender.tab?.id);

  const accountData = {
    ...data,
    cookieCount: cookieData.cookieCount,
    cookies: cookieData.cookiesArr,
    timestamp: Date.now(),
  };

  loginCompleted = true;
  await stagePendingAccountSync(accountData, sender.tab?.windowId);

  // Keep the login window alive as the action tab for this account.
  const windowId = sender.tab?.windowId;
  if (windowId) {
    try {
      await windowsUpdate(windowId, { state: 'minimized', focused: false });
      messageActionTabId = sender.tab.id;
      console.log('[ZaloTool BG] Incognito minimized, reused as action tab:', messageActionTabId);
    } catch (e) {
      console.warn('[ZaloTool BG] Failed to minimize, closing instead:', e.message);
      await closeIncognito(windowId);
    }
  }
}

function normalizeCookieList(account) {
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

function buildCookieUrl(cookie) {
  const host = (cookie.domain || '.zalo.me').replace(/^\./, '');
  return (cookie.secure === false ? 'http://' : 'https://') + host + (cookie.path || '/');
}

async function clearRegularZaloCookies() {
  const existing = await cookiesGetAll({ domain: '.zalo.me' });
  for (const cookie of existing) {
    if (!cookie?.name) continue;
    try {
      await cookiesRemove({
        url: buildCookieUrl(cookie),
        name: cookie.name,
        storeId: cookie.storeId,
      });
    } catch (_) {
      // Best-effort cleanup only.
    }
  }
}

async function closeManagedMessageActionWindow() {
  const windowId = messageActionManagedWindowId;
  messageActionManagedWindowId = null;
  messageActionTabId = null;

  if (windowId == null) {
    return;
  }

  closingWindowIds.add(windowId);
  try {
    await windowsRemove(windowId);
  } catch (_) {
    // Best-effort cleanup only.
  }
  closingWindowIds.delete(windowId);
}

async function applyAccountCookies(account) {
  const cookies = normalizeCookieList(account);
  if (!cookies.length) {
    throw new Error('Tài khoản chưa có cookie để khôi phục phiên Zalo. Hãy đồng bộ lại tài khoản trước khi nhắn tin.');
  }

  await clearRegularZaloCookies();

  for (const cookie of cookies) {
    const details = {
      url: buildCookieUrl(cookie),
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      secure: cookie.secure !== false,
      httpOnly: Boolean(cookie.httpOnly),
    };

    if (cookie.sameSite && cookie.sameSite !== 'unspecified') {
      details.sameSite = cookie.sameSite;
    }

    if (!cookie.session && typeof cookie.expirationDate === 'number' && Number.isFinite(cookie.expirationDate)) {
      details.expirationDate = cookie.expirationDate;
    }

    await cookiesSet(details);
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the Zalo tab to finish loading.'));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }

    function onRemoved(removedTabId) {
      if (removedTabId !== tabId) return;
      cleanup();
      reject(new Error('Tab Zalo thao tác đã bị đóng.'));
    }

    function onUpdated(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status !== 'complete') return;
      cleanup();
      resolve(tab);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    tabsGet(tabId)
      .then((tab) => {
        if (tab?.status === 'complete') {
          cleanup();
          resolve(tab);
        }
      })
      .catch(() => {
        cleanup();
        reject(new Error('Không thể truy cập tab Zalo thao tác.'));
      });
  });
}

function accountHasSessionIdentity(account) {
  return Boolean(account && (account.userId || account.UIN));
}

function sessionMatchesAccount(session, account) {
  if (!accountHasSessionIdentity(account)) {
    return false;
  }

  const accountUserId = String(account?.userId || '');
  const accountUIN = String(account?.UIN || '');
  const sessionUserId = String(session?.userId || '');
  const sessionUIN = String(session?.UIN || '');

  if (accountUserId && sessionUserId && accountUserId !== sessionUserId) {
    return false;
  }

  if (accountUIN && sessionUIN && accountUIN !== sessionUIN) {
    return false;
  }

  return Boolean((!accountUserId || sessionUserId) && (!accountUIN || sessionUIN));
}

async function getTabSessionSnapshot(tabId) {
  try {
    return await sendApiRequestToTab(tabId, {
      method: 'getSessionSnapshot',
      args: {},
    });
  } catch (_) {
    return null;
  }
}

async function waitForMatchingTabSession(tabId, account, maxAttempts = 8) {
  if (!accountHasSessionIdentity(account)) {
    return true;
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const session = await getTabSessionSnapshot(tabId);
    if (sessionMatchesAccount(session, account)) {
      return true;
    }

    await delay(1200 + (attempt * 250));
  }

  return false;
}

async function tryReinjectContentScripts(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/zalo-main.js'],
      world: 'MAIN',
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/zalo-bridge.js'],
    });
    await delay(3000);
  } catch (e) {
    console.warn('[ZaloTool BG] Failed to reinject content scripts into tab', tabId, e.message);
  }
}

async function findMatchingZaloTab(account) {
  const allTabs = await tabsQuery({ url: 'https://chat.zalo.me/*' });

  // First pass: try tabs that already have content scripts.
  for (const tab of allTabs) {
    if (!tab?.id || !tab.url?.includes('chat.zalo.me')) continue;

    const session = await getTabSessionSnapshot(tab.id);
    if (sessionMatchesAccount(session, account)) {
      return tab.id;
    }
  }

  // Second pass: reinject content scripts into unresponsive Zalo tabs and retry.
  for (const tab of allTabs) {
    if (!tab?.id || !tab.url?.includes('chat.zalo.me')) continue;

    await tryReinjectContentScripts(tab.id);
    const session = await getTabSessionSnapshot(tab.id);
    if (sessionMatchesAccount(session, account)) {
      return tab.id;
    }
  }

  return null;
}

async function focusMessageActionTab(tabId) {
  if (!tabId) return;

  try {
    const tab = await tabsGet(tabId);
    if (tab?.windowId != null) {
      try {
        await windowsUpdate(tab.windowId, { state: 'normal', focused: true });
      } catch (_) {
        // Best effort only. Some windows may already be normal.
      }
    }

    await tabsUpdate(tabId, { active: true });
    await delay(500);
  } catch (error) {
    console.warn('[ZaloTool BG] Failed to focus action tab:', error.message);
  }
}

async function ensureMessageActionTab(account, options = {}) {
  const interactive = Boolean(options.interactive);
  const forceReset = Boolean(options.forceReset);
  const allowCreateTab = options.allowCreateTab !== false;

  if (forceReset) {
    await closeManagedMessageActionWindow();
    messageActionTabId = null;
  }

  // 1. Reuse the current action tab if it still belongs to the selected account.
  if (messageActionTabId != null) {
    try {
      const existing = await tabsGet(messageActionTabId);
      if (existing?.url?.includes('chat.zalo.me')) {
        if (!accountHasSessionIdentity(account)) {
          if (interactive) {
            await focusMessageActionTab(existing.id);
          }
          return existing.id;
        }

        const existingSession = await getTabSessionSnapshot(existing.id);
        if (sessionMatchesAccount(existingSession, account)) {
          if (interactive) {
            await focusMessageActionTab(existing.id);
          }
          return existing.id;
        }
      }
    } catch (_) {
      // Fall through and recreate a dedicated action tab.
    }

    messageActionTabId = null;
  }

  // 2. Reuse an existing tab only when it belongs to the selected account.
  if (accountHasSessionIdentity(account)) {
    const matchingTabId = await findMatchingZaloTab(account);
    if (matchingTabId != null) {
      messageActionTabId = matchingTabId;
      messageActionManagedWindowId = null;
      if (interactive) {
        await focusMessageActionTab(matchingTabId);
      }
      return matchingTabId;
    }
  }

  if (!allowCreateTab) {
    throw new Error('Không tìm thấy tab Zalo đang mở cho tài khoản đã chọn. Hãy mở sẵn chat.zalo.me đúng tài khoản rồi thử lại.');
  }

  // 3. Fallback: create a dedicated action window.
  await applyAccountCookies(account);
  await delay(300);

  const createOptions = {
    url: 'https://chat.zalo.me/',
    focused: interactive,
  };

  if (interactive) {
    createOptions.width = 1280;
    createOptions.height = 900;
  } else {
    // Chrome does not allow width/height when state is minimized
    createOptions.state = 'minimized';
  }

  const win = await windowsCreate(createOptions);

  const newTab = win.tabs?.[0];
  if (!newTab) {
    throw new Error('Không thể tạo tab Zalo ẩn.');
  }

  messageActionTabId = newTab.id;
  messageActionManagedWindowId = win.id ?? null;
  await waitForTabComplete(newTab.id, 30000);

  const loaded = await tabsGet(newTab.id);
  if (!loaded?.url?.includes('chat.zalo.me')) {
    throw new Error('Phiên đăng nhập Zalo đã hết hạn. Vui lòng đồng bộ lại tài khoản.');
  }

  // Wait for content scripts + webpack API bridge to init
  await delay(5000);

  if (accountHasSessionIdentity(account)) {
    const matched = await waitForMatchingTabSession(newTab.id, account);
    if (!matched) {
      messageActionTabId = null;
      messageActionManagedWindowId = null;
      throw new Error('Tab Zalo thao tác không khớp với tài khoản đã chọn. Hãy đồng bộ lại tài khoản rồi thử lại.');
    }
  }

  if (interactive) {
    await focusMessageActionTab(newTab.id);
  }

  return newTab.id;
}

async function sendApiRequestToTab(tabId, request) {
  let response = null;

  try {
    response = await tabsSendMessage(tabId, {
      type: 'ZALOTOOL_API_REQUEST',
      data: request,
    });
  } catch (_) {
    await delay(1200);
    response = await tabsSendMessage(tabId, {
      type: 'ZALOTOOL_API_REQUEST',
      data: request,
    });
  }

  if (!response?.ok) {
    throw new Error(response?.error || 'Content script không xử lý được Zalo API request.');
  }

  return response.data || null;
}

async function probeMessageApiReady(tabId) {
  try {
    const probe = await sendApiRequestToTab(tabId, {
      method: 'checkApiReady',
      args: {},
    });
    return Boolean(probe?.ready);
  } catch (_) {
    return false;
  }
}

async function getZaloCommonData(payload) {
  const account = payload?.account;
  if (!account) {
    return { ok: false, error: 'Không có thông tin tài khoản để đồng bộ session.' };
  }

  await ensureAccountReady(account, 'Đồng bộ session');

  const tabId = await ensureMessageActionTab(account);
  const data = await sendApiRequestToTab(tabId, {
    method: 'getSessionSnapshot',
    args: {},
  });

  return { ok: true, data };
}

const READ_ONLY_ZALO_METHODS = new Set([
  'resolveGroupMembers',
  'resolveUserTargets',
  'getSessionSnapshot',
  'checkApiReady',
]);

async function forwardZaloApiRequest(payload) {
  const account = payload?.account;
  const request = payload?.request;
  const allowCreateTab = payload?.options?.allowCreateTab !== false;

  if (!account) {
    return { ok: false, error: 'Không có thông tin tài khoản để gửi request Zalo.' };
  }

  if (!request?.method) {
    return { ok: false, error: 'Thiếu method cho request Zalo.' };
  }

  await ensureAccountReady(account, 'Zalo API request');

  const tabId = await ensureMessageActionTab(account, { allowCreateTab });
  const data = await sendApiRequestToTab(tabId, request);
  return { ok: true, data };
}

async function prepareAndRunMessageBatch(payload) {
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const account = payload?.account;

  if (!jobs.length) {
    return { ok: false, error: 'Không có job nhắn tin để thực thi.' };
  }

  if (!account) {
    return { ok: false, error: 'Không có thông tin tài khoản để khởi chạy batch nhắn tin.' };
  }

  await ensureAccountReady(account, 'Batch nhắn tin');

  const allowCreateTab = payload?.options?.allowCreateTab !== false;
  let tabId = await ensureMessageActionTab(account, { interactive: false, allowCreateTab });
  let apiReady = await probeMessageApiReady(tabId);

  // Retry a few times before giving up — avoids creating extra windows.
  if (!apiReady) {
    await delay(3000);
    apiReady = await probeMessageApiReady(tabId);
  }
  if (!apiReady) {
    await focusMessageActionTab(tabId);
    await delay(4000);
    apiReady = await probeMessageApiReady(tabId);
  }
  if (!apiReady) {
    throw new Error('Zalo API bridge chưa sẵn sàng. Hãy đồng bộ lại tài khoản rồi gửi lại.');
  }
  let response = null;

  try {
    response = await tabsSendMessage(tabId, {
      type: 'ZALOTOOL_RUN_MESSAGE_BATCH',
      data: {
        jobs,
      },
    });
  } catch (_) {
    await delay(1200);
    response = await tabsSendMessage(tabId, {
      type: 'ZALOTOOL_RUN_MESSAGE_BATCH',
      data: {
        jobs,
      },
    });
  }

  if (!response?.ok) {
    throw new Error(response?.error || 'Content script không nhận batch nhắn tin.');
  }

  return {
    ok: true,
    accepted: jobs.length,
    tabId,
  };
}

async function startMessageBatch(payload) {
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const account = payload?.account;

  if (!jobs.length) {
    return { ok: false, error: 'Không có job nhắn tin để thực thi.' };
  }

  if (!account) {
    return { ok: false, error: 'Không có thông tin tài khoản để khởi chạy batch nhắn tin.' };
  }

  if (activeMessageBatch) {
    return { ok: false, error: 'Đang có batch nhắn tin khác chạy. Hãy dừng batch hiện tại trước khi chạy lại.' };
  }

  await ensureAccountReady(account, 'Batch nhắn tin');

  let tabId = null;
  try {
    tabId = await ensureMessageActionTab(account);
  } catch (_) {
    tabId = null;
  }
  trackActiveMessageBatch(jobs, tabId);

  Promise.resolve()
    .then(() => prepareAndRunMessageBatch(payload))
    .catch(async (error) => {
      console.error('[ZaloTool BG] Failed to start message batch:', error);
      activeMessageBatch = null;
      await failMessageJobs(jobs, error.message);
    });

  return {
    ok: true,
    accepted: jobs.length,
    status: 'starting',
  };
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== pendingLoginTabId) return;
  if (loginCompleted) return;
  if (changeInfo.status === 'complete' && tab?.url?.includes('chat.zalo.me')) {
    console.log('[ZaloTool BG] Pending login tab completed:', tab.url);
    scheduleReextract(tabId, 'tab-complete');
    scheduleFallbackFinalize();
  }
});

// ===== WINDOW LIFECYCLE =====
chrome.windows.onRemoved.addListener((windowId) => {
  if (closingWindowIds.has(windowId)) {
    closingWindowIds.delete(windowId);
    if (windowId === incognitoWindowId) {
      incognitoWindowId = null;
      pendingLoginTabId = null;
    }
    return;
  }

  if (windowId === incognitoWindowId) {
    clearPendingTimers();
    incognitoWindowId = null;
    pendingLoginTabId = null;
    messageActionTabId = null;

    // Only notify "login cancelled" if login hadn't completed yet
    if (!loginCompleted) {
      resetSyncState('cancelled', {
        mode: syncState.mode,
        error: 'Bạn đã đóng cửa sổ đăng nhập trước khi hoàn tất đồng bộ.',
      }).catch(() => {});
      for (const tabId of webAppTabs) {
        tabsSendMessage(tabId, { type: 'ZALOTOOL_LOGIN_CANCELLED' }).catch(() => {
          webAppTabs.delete(tabId);
        });
      }
    }
  }
});

// Clean up tab tracking
chrome.tabs.onRemoved.addListener((tabId) => {
  webAppTabs.delete(tabId);
  if (tabId === pendingLoginTabId) {
    clearPendingTimers();
    pendingLoginTabId = null;
  }
  if (tabId === messageActionTabId) {
    messageActionTabId = null;
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === messageActionManagedWindowId) {
    messageActionManagedWindowId = null;
    messageActionTabId = null;
  }
});

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}
