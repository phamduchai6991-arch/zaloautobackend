/* Runs in MAIN world at document_start on chat.zalo.me
   Waits for $$afmc.zStorage, extracts decrypted friend/group data,
   dispatches it to the ISOLATED content script via CustomEvent,
   and exposes a webpack API bridge for direct Zalo API calls.
   Also intercepts WebSocket to forward incoming messages in real-time. */

(function () {
  'use strict';

  var MAX_WAIT = 150; // 150 × 1s = 2.5 min
  var INITIAL_EXTRACT_DELAY = 2500;
  var EXTRACTION_RETRIES = 6;
  var EXTRACTION_RETRY_DELAY = 1500;
  var attempt = 0;

  // === Webpack API Bridge state ===
  var _wr = null;          // webpack __webpack_require__
  var _httpModule = null;      // fBUP.default
  var _businessModule = null;  // dThN.default
  var _apiReady = false;

  function dispatch(type, payload) {
    window.dispatchEvent(new CustomEvent('__zalotool__', {
      detail: JSON.stringify({ type: type, data: payload }),
    }));
  }

  // ============================================================
  // === WebSocket Interceptor for Real-Time Messages ===
  // ============================================================

  // Parse Zalo's binary WebSocket frame header: [version(1byte), cmd(3bytes LE), subCmd(1byte)]
  function parseWsHeader(buffer) {
    if (buffer.byteLength < 4) return null;
    var view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
    var version = view.getUint8(0);
    var cmd = view.getInt32(1, true); // little-endian, 3 bytes read as int32
    var subCmd = view.getInt8(3);
    return { version: version, cmd: cmd, subCmd: subCmd };
  }

  function tryParseWsMessage(data) {
    try {
      var buffer;
      if (data instanceof ArrayBuffer) {
        buffer = data;
      } else if (data instanceof Blob) {
        return null; // Can't sync-parse Blob - skip (rare)
      } else if (typeof data === 'string') {
        return null; // Text frames not used by Zalo for messages
      } else if (data && data.buffer) {
        buffer = data.buffer;
      } else {
        return null;
      }

      if (buffer.byteLength < 5) return null;

      var header = parseWsHeader(buffer);
      if (!header || header.version !== 1) return null;

      // Only intercept message commands
      // cmd 501 = 1:1 user messages, cmd 521 = group messages
      if (header.cmd !== 501 && header.cmd !== 521) return null;
      if (header.subCmd !== 0) return null;

      var bodyBytes = new Uint8Array(buffer, 4);
      var bodyText = new TextDecoder('utf-8').decode(bodyBytes);
      if (!bodyText || bodyText.length === 0) return null;

      var parsed = JSON.parse(bodyText);
      return { header: header, data: parsed };
    } catch (_) {
      return null;
    }
  }

  function handleIncomingWsMessage(header, parsedData) {
    try {
      var messages = [];
      var isGroup = header.cmd === 521;

      if (header.cmd === 501 && parsedData.msgs) {
        messages = parsedData.msgs;
      } else if (header.cmd === 521 && parsedData.groupMsgs) {
        messages = parsedData.groupMsgs;
      }

      if (!Array.isArray(messages) || messages.length === 0) return;

      var normalized = [];
      for (var i = 0; i < messages.length; i++) {
        var msg = messages[i];
        if (!msg || typeof msg !== 'object') continue;
        // Skip undo/delete notifications
        if (msg.content && typeof msg.content === 'object' && msg.content.deleteMsg) continue;

        normalized.push({
          msgId: String(msg.msgId || msg.globalMsgId || msg.actionId || msg.realMsgId || msg.cliMsgId || msg.id || ''),
          fromId: String(msg.uidFrom || msg.fromUid || msg.fromId || msg.senderId || msg.uid || ''),
          toId: String(msg.idTo || msg.toId || msg.toUid || ''),
          content: extractMessageContent(msg) || '[Tin nhắn không có nội dung]',
          rawContent: getRawMessageContent(msg),
          ts: Number(msg.ts || 0),
          msgType: msg.msgType || msg.type || 'text',
          dName: msg.dName || '',
          isGroup: isGroup,
          threadId: isGroup
            ? normalizeConversationId(msg.idTo || msg.toId || '', true)
            : normalizeConversationId(msg.uidFrom === '0' ? (msg.idTo || msg.toId || '') : (msg.uidFrom || msg.fromUid || msg.fromId || '')),
        });
      }

      if (normalized.length > 0) {
        console.log('[ZaloMain] WS intercepted', normalized.length, isGroup ? 'group' : 'user', 'messages');
        dispatch('incoming_messages', normalized);
      }
    } catch (err) {
      console.warn('[ZaloMain] WS message parse error:', err.message);
    }
  }

  // Monkey-patch WebSocket to intercept incoming messages
  var _OrigWebSocket = window.WebSocket;
  window.WebSocket = function ZaloWSInterceptor(url, protocols) {
    var ws = protocols !== undefined
      ? new _OrigWebSocket(url, protocols)
      : new _OrigWebSocket(url);

    // Only intercept Zalo's message WebSocket
    if (url && url.indexOf('zalo.me') !== -1) {
      var origOnMessage = null;

      // Intercept .onmessage setter
      Object.defineProperty(ws, 'onmessage', {
        get: function () { return origOnMessage; },
        set: function (fn) {
          origOnMessage = function (event) {
            // Try to intercept, but always pass through
            var parsed = tryParseWsMessage(event.data);
            if (parsed) {
              handleIncomingWsMessage(parsed.header, parsed.data);
            }
            if (typeof fn === 'function') fn.call(ws, event);
          };
        },
        configurable: true,
      });

      // Also intercept addEventListener('message', ...)
      var origAddEventListener = ws.addEventListener.bind(ws);
      ws.addEventListener = function (type, listener, options) {
        if (type === 'message') {
          var wrappedListener = function (event) {
            var parsed = tryParseWsMessage(event.data);
            if (parsed) {
              handleIncomingWsMessage(parsed.header, parsed.data);
            }
            if (typeof listener === 'function') listener.call(ws, event);
            else if (listener && typeof listener.handleEvent === 'function') listener.handleEvent(event);
          };
          return origAddEventListener(type, wrappedListener, options);
        }
        return origAddEventListener(type, listener, options);
      };
    }

    return ws;
  };
  // Preserve prototype chain
  window.WebSocket.prototype = _OrigWebSocket.prototype;
  window.WebSocket.CONNECTING = _OrigWebSocket.CONNECTING;
      rawContent: getRawMessageContent(msg),
  window.WebSocket.CLOSING = _OrigWebSocket.CLOSING;
  window.WebSocket.CLOSED = _OrigWebSocket.CLOSED;

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function withTimeout(promise, ms, fallbackValue) {
    return new Promise(function (resolve) {
      var settled = false;
      var timeoutId = setTimeout(function () {
        if (!settled) {
          settled = true;
          resolve(fallbackValue);
        }
      }, ms);

      Promise.resolve(promise)
        .then(function (value) {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          resolve(value);
        })
        .catch(function () {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          resolve(fallbackValue);
        });
    });
  }

  function toArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (value instanceof Map) return Array.from(value.values());
    if (typeof value === 'object') return Object.values(value);
    return [];
  }

  function dedupeBy(items, getKey) {
    var seen = new Set();
    return items.filter(function (item) {
      var key = getKey(item);
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function normalizeFriend(friend) {
    if (!friend) return null;
    return {
      userId: friend.userId || '',
      username: friend.username || '',
      displayName: friend.displayName || '',
      zaloName: friend.zaloName || '',
      avatar: friend.avatar || '',
      gender: friend.gender,
      dob: friend.dob,
      sdob: friend.sdob || '',
      status: friend.status || '',
      phoneNumber: friend.phoneNumber || '',
      isFr: friend.isFr,
      isBlocked: friend.isBlocked,
      isActive: friend.isActive,
      globalId: friend.globalId || '',
      type: friend.type,
      user_mode: friend.user_mode,
      bizInfo: friend.bizInfo || null,
    };
  }

  function normalizeGroup(group) {
    if (!group) return null;

    var memberIds = group.memberIds || group.member_ids || group.members || group.participantIds || [];
    var normalized = {
      userId: group.userId || group.groupId || group.id || group.convId || group.conv_id || group.threadId || '',
      displayName: group.displayName || group.groupName || group.group_name || group.name || group.title || '',
      avatar: group.avatar || group.avatarUrl || group.avatar_hd || '',
      totalMember: group.totalMember || group.memberCount || group.group_member_count || (Array.isArray(memberIds) ? memberIds.length : 0),
      memberIds: Array.isArray(memberIds) ? memberIds : [],
      creatorId: group.creatorId || group.ownerId || group.creator || '',
      type: group.type,
      subType: group.subType || group.groupType,
      globalId: group.globalId || group.convId || group.conv_id || '',
      desc: group.desc || group.description || group.groupDesc || '',
    };

    if (!normalized.userId && !normalized.globalId && !normalized.displayName) return null;
    return normalized;
  }

  function openIndexedDb(name, version) {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(name, version);
      request.onsuccess = function (event) {
        resolve(event.target.result);
      };
      request.onerror = function () {
        reject(request.error || new Error('Failed to open IndexedDB'));
      };
    });
  }

  function readStore(db, storeName) {
    return new Promise(function (resolve, reject) {
      if (!db.objectStoreNames || !db.objectStoreNames.contains(storeName)) {
        resolve([]);
        return;
      }

      var transaction = db.transaction(storeName, 'readonly');
      var store = transaction.objectStore(storeName);
      var request = store.getAll();

      request.onsuccess = function () {
        resolve(toArray(request.result));
      };
      request.onerror = function () {
        reject(request.error || new Error('Failed to read store'));
      };
    });
  }

  async function collectIndexedDbGroups() {
    if (!window.indexedDB || typeof indexedDB.databases !== 'function') return [];

    var databases = [];
    try {
      databases = await withTimeout(indexedDB.databases(), 1500, []);
    } catch (_) {
      return [];
    }

    var allGroups = [];
    for (var i = 0; i < databases.length; i++) {
      var dbMeta = databases[i];
      if (!dbMeta || !dbMeta.name) continue;

      var db = null;
      try {
        db = await withTimeout(openIndexedDb(dbMeta.name, dbMeta.version), 1000, null);
        if (!db) continue;
        var groups = await withTimeout(readStore(db, 'group'), 1000, []);
        allGroups = allGroups.concat(groups);
      } catch (_) {
        // Ignore unrelated databases.
      } finally {
        if (db) {
          try { db.close(); } catch (_) {}
        }
      }
    }

    return dedupeBy(
      allGroups.map(normalizeGroup).filter(Boolean),
      function (group) { return group.userId || group.globalId || group.displayName; }
    );
  }

  function isGroupConversation(conversation) {
    if (!conversation) return false;

    if (conversation.isGroup === true || conversation.isGroupChat === true) return true;
    if (typeof conversation.type === 'string' && conversation.type.toLowerCase().indexOf('group') !== -1) return true;
    if (typeof conversation.subType === 'string' && conversation.subType.toLowerCase().indexOf('group') !== -1) return true;
    if (conversation.groupName || conversation.group_name) return true;

    var memberIds = conversation.memberIds || conversation.member_ids || conversation.members || conversation.participantIds;
    return Array.isArray(memberIds) && memberIds.length > 2;
  }

  async function collectConversationGroups(zs) {
    if (!zs || typeof zs.getConversations !== 'function') return [];

    var conversations = [];
    try {
      conversations = await withTimeout(zs.getConversations(), 1500, []);
    } catch (_) {
      return [];
    }

    return dedupeBy(
      toArray(conversations)
        .filter(isGroupConversation)
        .map(normalizeGroup)
        .filter(Boolean),
      function (group) { return group.userId || group.globalId || group.displayName; }
    );
  }

  async function collectGroups(zs) {
    var directGroups = [];
    try {
      directGroups = toArray(await withTimeout(zs.getGroups(), 1500, []));
    } catch (_) {}

    var indexedDbGroups = [];
    if (!directGroups.length) {
      indexedDbGroups = await collectIndexedDbGroups();
    }

    var conversationGroups = [];
    if (!directGroups.length && !indexedDbGroups.length) {
      conversationGroups = await collectConversationGroups(zs);
    }

    return dedupeBy(
      directGroups
        .map(normalizeGroup)
        .filter(Boolean)
        .concat(indexedDbGroups)
        .concat(conversationGroups),
      function (group) { return group.userId || group.globalId || group.displayName; }
    );
  }

  async function collectSnapshot(zs) {
    var me = null;
    try { me = await withTimeout(zs.getMe(), 1500, null); } catch (_) {}

    var friends = [];
    try {
      friends = dedupeBy(
        toArray(await withTimeout(zs.getFriends(), 1500, []))
          .map(normalizeFriend)
          .filter(Boolean),
        function (friend) { return friend.userId || friend.globalId || friend.username; }
      );
    } catch (_) {}

    var groups = await collectGroups(zs);
    return { me: me, friends: friends, groups: groups };
  }

  async function extractAll() {
    var zs = window.$$afmc && window.$$afmc.zStorage;
    if (!zs) return false;

    console.log('[ZaloMain] $$afmc.zStorage ready — extracting data');

    try {
      var best = { me: null, friends: [], groups: [] };

      for (var round = 1; round <= EXTRACTION_RETRIES; round++) {
        var snapshot = await collectSnapshot(zs);
        if (!best.me && snapshot.me) best.me = snapshot.me;
        if (snapshot.friends.length >= best.friends.length) best.friends = snapshot.friends;
        if (snapshot.groups.length >= best.groups.length) best.groups = snapshot.groups;

        console.log(
          '[ZaloMain] Extraction attempt',
          round,
          'friends:', best.friends.length,
          'groups:', best.groups.length
        );

        if (round >= 3 && (best.groups.length > 0 || best.friends.length > 0)) {
          break;
        }

        if (round < EXTRACTION_RETRIES) {
          await delay(EXTRACTION_RETRY_DELAY);
        }
      }

      if (best.me) dispatch('me', best.me);
      if (best.friends.length) {
        dispatch('friends', best.friends);
        console.log('[ZaloMain] Extracted', best.friends.length, 'friends');
      }
      if (best.groups.length) {
        dispatch('groups', best.groups);
        console.log('[ZaloMain] Extracted', best.groups.length, 'groups');
      }

      dispatch('done', {
        friends: best.friends.length,
        groups: best.groups.length,
      });

      // Now safe to init webpack API bridge (extraction done)
      _extractionDone = true;
      setTimeout(tryInitApi, 500);

      return true;
    } catch (e) {
      console.error('[ZaloMain] Extraction error:', e);
      _extractionDone = true;
      setTimeout(tryInitApi, 500);
      return false;
    }
  }

  // ============================================================
  // === Webpack API Bridge ===
  // ============================================================

  var _encoderModule = null;
  var _domainsModule = null;

  function initWebpackApi() {
    if (_apiReady) return true;

    // Fix broken XHR interceptor from previous trace scripts
    if (!window.__apiTrace) window.__apiTrace = [];

    // Get __webpack_require__ via webpackJsonp.push trick
    if (!_wr) {
      try {
        window.webpackJsonp.push([['__zalotool_wr__'], {
          '__zalotool_wr__': function (module, exports, require) { _wr = require; }
        }, [['__zalotool_wr__']]]);
        // Clean up to avoid interfering with Zalo's webpack runtime
        try { window.webpackJsonp.pop(); } catch (_) {}
      } catch (e) {
        console.warn('[ZaloMain] webpackJsonp not available yet:', e.message);
        return false;
      }
    }

    if (!_wr) return false;

    // Load transport + business modules from Zalo's webpack runtime.
    try {
      var fBUP = _wr('fBUP');
      _httpModule = fBUP && fBUP.default;
    } catch (e) {
      console.warn('[ZaloMain] Failed to load fBUP:', e.message);
    }

    try {
      var dThN = _wr('dThN');
      _businessModule = dThN && dThN.default;
    } catch (e) {
      console.warn('[ZaloMain] Failed to load dThN:', e.message);
    }

    // Load AES encoder module — needed for decodeAES hook
    // Strategy A: Try known webpack IDs (including variations Zalo may use)
    var knownEncoderIds = ['z0WU', 'ZEncoder', 'aes_utils', 'aes', 'crypto_utils', 'encrypt'];
    for (var ki = 0; ki < knownEncoderIds.length && !_encoderModule; ki++) {
      try {
        var eMod = _wr(knownEncoderIds[ki]);
        var eDef = eMod && (eMod.default || eMod);
        if (eDef && typeof eDef.decodeAES === 'function') {
          _encoderModule = eDef;
          console.log('[ZaloMain] Found encoder module via known ID:', knownEncoderIds[ki]);
        }
      } catch (_) {}
    }

    // Strategy B: Scan webpack module cache for decodeAES or encodeAES
    if (!_encoderModule && _wr && _wr.c) {
      var moduleCache = _wr.c;
      var cacheKeys = Object.keys(moduleCache);
      console.log('[ZaloMain] Searching', cacheKeys.length, 'webpack modules for decodeAES/encodeAES...');
      for (var ci = 0; ci < cacheKeys.length; ci++) {
        try {
          var cachedMod = moduleCache[cacheKeys[ci]];
          var exp = cachedMod && cachedMod.exports;
          if (!exp) continue;
          // Check exports.default.decodeAES
          if (exp.default && typeof exp.default.decodeAES === 'function') {
            _encoderModule = exp.default;
            console.log('[ZaloMain] Found encoder module by scanning cache, key:', cacheKeys[ci]);
            break;
          }
          // Check exports.decodeAES directly
          if (typeof exp.decodeAES === 'function') {
            _encoderModule = exp;
            console.log('[ZaloMain] Found encoder module (direct export), key:', cacheKeys[ci]);
            break;
          }
          // Check for encodeAES (may be bundled differently)
          if (exp.default && typeof exp.default.encodeAES === 'function') {
            _encoderModule = exp.default;
            console.log('[ZaloMain] Found encoder module via encodeAES, key:', cacheKeys[ci]);
            break;
          }
          if (typeof exp.encodeAES === 'function') {
            _encoderModule = exp;
            console.log('[ZaloMain] Found encoder module via encodeAES (direct), key:', cacheKeys[ci]);
            break;
          }
        } catch (_) {}
      }
    }

    // Strategy C: Scan module SOURCE CODE for "decodeAES" string, then load only matching modules
    if (!_encoderModule && _wr && _wr.m) {
      var allModuleIds = Object.keys(_wr.m);
      var candidateIds = [];
      for (var si = 0; si < allModuleIds.length; si++) {
        try {
          var src = _wr.m[allModuleIds[si]];
          var srcStr = typeof src === 'function' ? src.toString() : String(src || '');
          if (srcStr.indexOf('decodeAES') !== -1 || srcStr.indexOf('encodeAES') !== -1) {
            candidateIds.push(allModuleIds[si]);
          }
        } catch (_) {}
      }
      console.log('[ZaloMain] Found', candidateIds.length, 'candidate AES modules from', allModuleIds.length, 'total:', candidateIds.join(', '));
      for (var ci2 = 0; ci2 < candidateIds.length && !_encoderModule; ci2++) {
        try {
          var tryMod = _wr(candidateIds[ci2]);
          var tryDef = tryMod && (tryMod.default || tryMod);
          if (tryDef && typeof tryDef.decodeAES === 'function') {
            _encoderModule = tryDef;
            console.log('[ZaloMain] Found encoder module by source scan, ID:', candidateIds[ci2]);
          } else if (tryDef && typeof tryDef.encodeAES === 'function') {
            _encoderModule = tryDef;
            console.log('[ZaloMain] Found encoder module (encodeAES only) by source scan, ID:', candidateIds[ci2]);
          }
          // Also check nested exports
          if (!_encoderModule && tryMod) {
            var tryKeys = Object.keys(tryMod);
            for (var tk = 0; tk < tryKeys.length && !_encoderModule; tk++) {
              var tryExp = tryMod[tryKeys[tk]];
              if (tryExp && typeof tryExp.decodeAES === 'function') {
                _encoderModule = tryExp;
                console.log('[ZaloMain] Found encoder module (nested export "' + tryKeys[tk] + '") by source scan, ID:', candidateIds[ci2]);
              }
            }
          }
        } catch (_) {}
      }
    }

    // Strategy D: Last resort — exhaustive search loading all unloaded modules
    if (!_encoderModule && _wr && _wr.m) {
      var unloadedIds = Object.keys(_wr.m).filter(function (id) { return !(_wr.c && _wr.c[id]); });
      if (unloadedIds.length < 2000) {
        console.log('[ZaloMain] Exhaustive search: loading', unloadedIds.length, 'unloaded modules...');
        for (var mi = 0; mi < unloadedIds.length && !_encoderModule; mi++) {
          try {
            var tryMod2 = _wr(unloadedIds[mi]);
            var tryDef2 = tryMod2 && (tryMod2.default || tryMod2);
            if (tryDef2 && typeof tryDef2.decodeAES === 'function') {
              _encoderModule = tryDef2;
              console.log('[ZaloMain] Found encoder module by exhaustive search, ID:', unloadedIds[mi]);
            }
          } catch (_) {}
        }
      } else {
        console.warn('[ZaloMain] Too many unloaded modules (' + unloadedIds.length + '), skipping exhaustive search');
      }
    }

    if (!_encoderModule) {
      console.warn('[ZaloMain] decodeAES module NOT found — will rely on getGroupInfos API + currentMems.dName for names');
    } else {
      console.log('[ZaloMain] Encoder module loaded, has decodeAES:', typeof _encoderModule.decodeAES, 'encodeAES:', typeof _encoderModule.encodeAES);
    }

    // Load domains module — try known IDs
    var knownDomainIds = ['pUq9', 'domains'];
    for (var di = 0; di < knownDomainIds.length && !_domainsModule; di++) {
      try {
        _domainsModule = _wr(knownDomainIds[di]);
      } catch (_) {}
    }

    // Hook decodeAES to bypass lockViewMember (Zalo-F12 approach)
    // This modifies the AES-decrypted response BEFORE Zalo client processes it,
    // setting lockViewMember=0 so the client returns ALL group members
    if (_encoderModule && typeof _encoderModule.decodeAES === 'function' && !_encoderModule._zalotool_hooked) {
      _encoderModule._zalotool_hooked = true;
      _encoderModule.decodeAES_original = _encoderModule.decodeAES;
      _encoderModule.decodeAES = function (e, t) {
        var n = _encoderModule.decodeAES_original(e, t || 0);
        try {
          var json = JSON.parse(n);
          if (json && json.error_code === 0 && json.data && json.data.gridInfoMap) {
            var changed = false;
            Object.keys(json.data.gridInfoMap).forEach(function (grid) {
              var group = json.data.gridInfoMap[grid];
              if (group && group.setting) {
                group.setting.lockViewMember = 0;
                changed = true;
              }
            });
            if (changed) {
              n = JSON.stringify(json);
              console.log('[ZaloMain] decodeAES hook: unlocked lockViewMember for', Object.keys(json.data.gridInfoMap).length, 'groups');
            }
          }
        } catch (_) {}
        return n;
      };
      console.log('[ZaloMain] decodeAES hook installed — lockViewMember bypass active');
    }

    _apiReady = !!(_businessModule || _httpModule);
    return _apiReady;
  }

  function getSendTextFunction() {
    var candidates = [
      _businessModule,
      _httpModule,
    ].filter(Boolean);

    for (var moduleIndex = 0; moduleIndex < candidates.length; moduleIndex += 1) {
      var module = candidates[moduleIndex];
      var direct = module && module.sendZText;
      if (typeof direct === 'function') {
        return {
          fn: direct.bind(module),
          source: module === _businessModule ? 'business' : 'transport',
        };
      }

      var alternativeNames = ['sendText', 'sendTextMessage', 'sendMessageText'];
      for (var nameIndex = 0; nameIndex < alternativeNames.length; nameIndex += 1) {
        var candidateName = alternativeNames[nameIndex];
        if (typeof module[candidateName] === 'function') {
          return {
            fn: module[candidateName].bind(module),
            source: module === _businessModule ? 'business' : 'transport',
          };
        }
      }
    }

    return null;
  }

  function generateClientId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 8);
  }

  function firstNonEmpty(values) {
    for (var i = 0; i < values.length; i += 1) {
      var value = values[i];
      if (value == null) continue;
      var text = String(value).trim();
      if (text) return text;
    }
    return '';
  }

  function normalizeTimestamp(value) {
    if (value == null || value === '') return 0;
    var num = Number(value);
    if (!isFinite(num) || num <= 0) return 0;
    if (num < 1000000000000) {
      return Math.round(num * 1000);
    }
    return Math.round(num);
  }

  function normalizeConversationId(value, isGroup) {
    var text = String(value || '').trim();
    if (!text) return '';
    if (isGroup && (text.charAt(0) === 'g' || text.charAt(0) === 'G')) {
      return text.slice(1);
    }
    return text;
  }

  function safeJsonParse(value) {
    if (typeof value !== 'string') return null;
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  }

  function visitCandidateValue(value, path, target, depth) {
    if (depth > 3 || value == null) return;

    if (typeof value === 'string') {
      var lowerPath = String(path || '').toLowerCase();
      if (!target.decryptKey && (lowerPath.indexOf('zpw_enk') !== -1 || lowerPath.indexOf('decrypt') !== -1 || lowerPath.indexOf('enk') !== -1)) {
        target.decryptKey = value;
        target.sessionSource.push(path);
      }
      if (!target.labelVersion && lowerPath.indexOf('label') !== -1 && lowerPath.indexOf('version') !== -1) {
        target.labelVersion = value;
        target.sessionSource.push(path);
      }

      var parsed = safeJsonParse(value);
      if (parsed && typeof parsed === 'object') {
        visitCandidateValue(parsed, path + '.json', target, depth + 1);
      }
      return;
    }

    if (Array.isArray(value)) {
      for (var i = 0; i < Math.min(value.length, 10); i += 1) {
        visitCandidateValue(value[i], path + '[' + i + ']', target, depth + 1);
      }
      return;
    }

    if (typeof value === 'object') {
      var keys = Object.keys(value).slice(0, 30);
      for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
        var key = keys[keyIndex];
        var nextPath = path ? path + '.' + key : key;
        if (!target.commonData && key.toLowerCase() === 'commondata') {
          target.commonData = value[key];
          target.sessionSource.push(nextPath);
        }
        visitCandidateValue(value[key], nextPath, target, depth + 1);
      }
    }
  }

  function extractSessionHints() {
    var target = {
      decryptKey: '',
      labelVersion: null,
      commonData: null,
      sessionSource: [],
    };

    [window.localStorage, window.sessionStorage].forEach(function (storage, storageIndex) {
      if (!storage) return;
      for (var i = 0; i < storage.length; i += 1) {
        var key = storage.key(i);
        if (!key) continue;
        var value = null;
        try { value = storage.getItem(key); } catch (_) { value = null; }
        visitCandidateValue(value, (storageIndex === 0 ? 'localStorage.' : 'sessionStorage.') + key, target, 0);
      }
    });

    return target;
  }

  function buildSessionSnapshot() {
    var imei = '';
    try {
      var X4fA = _wr('X4fA');
      if (X4fA && X4fA.a && typeof X4fA.a.getZaloClientID === 'function') {
        imei = X4fA.a.getZaloClientID();
      }
    } catch (_) {}

    var userId = '';
    var UIN = '';
    var commonParams = '';
    try {
      var sessionSource = _businessModule || _httpModule;
      userId = sessionSource && (sessionSource.userId || sessionSource.uid || '');
      UIN = sessionSource && (sessionSource.UIN || '');
      commonParams = sessionSource && typeof sessionSource._getCommonParams === 'function'
        ? sessionSource._getCommonParams()
        : '';
    } catch (_) {}

    var hints = extractSessionHints();
    return {
      imei: imei,
      userId: userId,
      UIN: UIN,
      commonParams: commonParams,
      decryptKey: hints.decryptKey || '',
      labelVersion: hints.labelVersion || null,
      commonData: hints.commonData || {
        userId: userId,
        UIN: UIN,
        commonParams: commonParams,
      },
      sessionSource: hints.sessionSource,
    };
  }

  function getConversationIdentifier(conversation) {
    if (!conversation) return '';

    var isGroup = isGroupConversation(conversation);
    return normalizeConversationId(
      firstNonEmpty([
        conversation.userId,
        conversation.id,
        conversation.globalId,
        conversation.convId,
        conversation.conv_id,
        conversation.groupId,
        conversation.threadId,
      ]),
      isGroup
    );
  }

  function getConversationDisplayName(conversation) {
    if (!conversation) return '';

    return firstNonEmpty([
      conversation.displayName,
      conversation.name,
      conversation.title,
      conversation.groupName,
      conversation.group_name,
      conversation.fullName,
      conversation.zaloName,
      conversation.username,
      conversation.userName,
      conversation.alias,
    ]);
  }

  function getConversationAvatar(conversation) {
    if (!conversation) return '';

    return firstNonEmpty([
      conversation.avatar,
      conversation.avatarUrl,
      conversation.thumb,
      conversation.thumbSrc,
      conversation.profileUrl,
      conversation.icon,
      conversation.photoUrl,
    ]);
  }

  function toReadableText(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number') return String(value);
    return '';
  }

  function tryParseJsonString(value) {
    var text = String(value || '').trim();
    if (!text) return null;
    if (text.charAt(0) !== '{' && text.charAt(0) !== '[') return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function inferMessageLabel(node) {
    if (!node || typeof node !== 'object') return '';

    var type = String(node.msgType || node.type || node.mediaType || node.attachmentType || '').toLowerCase();
    var containType = Number((node.paramsExt && node.paramsExt.containType) || node.containType || 0);

    if (node.fileName || node.file_name) return '[File] ' + (node.fileName || node.file_name);
    if (node.thumb || node.thumbSrc || node.hdUrl || node.normalUrl || node.imageUrl || node.photoUrl || node.thumbnail || node.image) return '[Hình ảnh]';
    if (node.videoUrl || node.video || type.indexOf('video') !== -1) return '[Video]';
    if (node.audioUrl || node.voiceUrl || node.audio || type.indexOf('audio') !== -1 || type.indexOf('voice') !== -1) return '[Âm thanh]';
    if (node.stickerId || type.indexOf('sticker') !== -1) return '[Sticker]';
    if (type.indexOf('location') !== -1) return '[Vị trí]';
    if (type.indexOf('file') !== -1) return '[Tệp đính kèm]';
    if (type.indexOf('gif') !== -1) return '[GIF]';
    if (type.indexOf('link') !== -1) return '[Liên kết]';
    if (type.indexOf('photo') !== -1 || containType === 2) return '[Hình ảnh]';
    if (type.indexOf('poll') !== -1) return '[Bình chọn]';
    if (type.indexOf('todo') !== -1) return '[Công việc]';

    return '';
  }

  function extractContentFromNode(node, depth) {
    if (depth > 4 || node == null) return '';

    if (typeof node === 'string' || typeof node === 'number') {
      var parsedNode = typeof node === 'string' ? tryParseJsonString(node) : null;
      if (parsedNode) {
        var parsedText = extractContentFromNode(parsedNode, depth + 1);
        if (parsedText) return parsedText;
      }
      return toReadableText(node);
    }

    if (Array.isArray(node)) {
      for (var itemIndex = 0; itemIndex < node.length; itemIndex += 1) {
        var itemText = extractContentFromNode(node[itemIndex], depth + 1);
        if (itemText) return itemText;
      }
      return '';
    }

    if (typeof node !== 'object') return '';

    var directCandidates = [
      node.text,
      node.content,
      node.description,
      node.title,
      node.name,
      node.subTitle,
      node.subtitle,
      node.caption,
      node.body,
      node.msg,
      node.message,
      node.summary,
      node.snippet,
      node.href,
      node.url,
      node.link,
    ];

    for (var candidateIndex = 0; candidateIndex < directCandidates.length; candidateIndex += 1) {
      var directText = toReadableText(directCandidates[candidateIndex]);
      if (directText) {
        if (candidateIndex >= 13) {
          return '[Liên kết] ' + directText;
        }
        return directText;
      }
    }

    var inferredLabel = inferMessageLabel(node);
    if (inferredLabel) return inferredLabel;

    var nestedCandidates = [
      node.data,
      node.params,
      node.meta,
      node.attach,
      node.attachment,
      node.attachments,
      node.payload,
      node.extra,
      node.quote,
    ];

    for (var nestedIndex = 0; nestedIndex < nestedCandidates.length; nestedIndex += 1) {
      var nestedText = extractContentFromNode(nestedCandidates[nestedIndex], depth + 1);
      if (nestedText) return nestedText;
    }

    if (node.quote && typeof node.quote === 'object') {
      var quoteText = extractContentFromNode(node.quote.msg, depth + 1) || extractContentFromNode(node.quote.attach, depth + 1);
      if (quoteText) return quoteText;
    }

    return '';
  }

  function extractMessageContent(message) {
    if (!message || typeof message !== 'object') return '';

    var fields = [
      message.content,
      message.msg,
      message.message,
      message.text,
      message.body,
      message.preview,
      message.snippet,
      message.lastMsg,
      message.lastMessage,
      message.last_message,
      message.lastMessageText,
      message.lastMsgObj,
      message.last_msg_obj,
      message.lastMessageObj,
      message.quote,
      message.data,
      message.params,
    ];

    for (var fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
      var content = extractContentFromNode(fields[fieldIndex], 0);
      if (content) return content;
    }

    var fallbackLabel = inferMessageLabel(message);
    if (fallbackLabel) return fallbackLabel;

    return '';
  }

  function getRawMessageContent(message) {
    if (!message || typeof message !== 'object') return null;
    if (message.content != null) return message.content;
    if (message.message != null) return message.message;
    if (message.msg != null) return message.msg;
    if (message.data != null) return message.data;
    if (message.params != null) return message.params;
    return null;
  }

  function getConversationLastMessage(conversation) {
    if (!conversation) return '';

    var rawMessage = firstNonEmpty([
      conversation.lastMsg,
      conversation.lastMessage,
      conversation.last_message,
      conversation.lastMessageText,
      conversation.snippet,
      conversation.preview,
    ]);

    if (rawMessage) return rawMessage;

    var messageObject = conversation.lastMsgObj || conversation.last_msg_obj || conversation.lastMessageObj || null;
    return extractMessageContent(messageObject || conversation);
  }

  function normalizeConversationItem(conversation) {
    if (!conversation) return null;

    var isGroup = isGroupConversation(conversation);
    var id = getConversationIdentifier(conversation);
    var displayName = getConversationDisplayName(conversation);

    if (!id && !displayName) return null;

    var unreadCount = Number(
      conversation.unreadCount ||
      conversation.unread ||
      conversation.totalUnread ||
      conversation.badge ||
      0
    ) || 0;

    var memberIds = conversation.memberIds || conversation.member_ids || conversation.members || conversation.participantIds || [];

    return {
      id: id,
      rawId: firstNonEmpty([
        conversation.userId,
        conversation.id,
        conversation.globalId,
        conversation.convId,
        conversation.conv_id,
        conversation.groupId,
        conversation.threadId,
      ]),
      userId: normalizeConversationId(conversation.userId, isGroup),
      groupId: normalizeConversationId(conversation.groupId || conversation.convId || conversation.conv_id, true),
      globalId: firstNonEmpty([conversation.globalId]),
      displayName: displayName,
      avatar: getConversationAvatar(conversation),
      isGroup: isGroup,
      lastMessage: getConversationLastMessage(conversation),
      lastMsgTime: normalizeTimestamp(
        conversation.lastMsgTime ||
        conversation.actionTime ||
        conversation.lastActionTime ||
        conversation.last_time ||
        conversation.updateTime
      ),
      unreadCount: unreadCount,
      isPinned: Boolean(conversation.isPinned || conversation.pinned || conversation.isPin),
      isMuted: Boolean(conversation.isMuted || conversation.muted || conversation.mute),
      memberCount: Array.isArray(memberIds)
        ? memberIds.length
        : Number(conversation.totalMember || conversation.memberCount || 0) || 0,
      type: conversation.type || '',
      subType: conversation.subType || conversation.groupType || '',
      lastMessageType: firstNonEmpty([
        conversation.lastMsgType,
        conversation.lastMessageType,
        conversation.msgType,
      ]),
    };
  }

  async function getConversationList() {
    var zs = window.$$afmc && window.$$afmc.zStorage;
    if (!zs || typeof zs.getConversations !== 'function') {
      return [];
    }

    try {
      var conversations = await withTimeout(zs.getConversations(), 2000, []);
      var items = toArray(conversations)
        .map(normalizeConversationItem)
        .filter(Boolean)
        .sort(function (left, right) {
          return Number(right.lastMsgTime || 0) - Number(left.lastMsgTime || 0);
        });

      // Resolve display names for conversations that have no name
      if (initWebpackApi()) {
        var unknownIds = items
          .filter(function (c) { return !c.isGroup && (!c.displayName || c.displayName === 'Không rõ tên'); })
          .map(function (c) { return c.id || c.rawId || c.userId; })
          .filter(Boolean);

        if (unknownIds.length > 0) {
          try {
            var versionedIds = unknownIds.map(normalizeMemberVersionKey).filter(Boolean);
            var profileResult = await withTimeout(
              callFirstAvailableMethod(['getUserInfo'], [versionedIds]),
              8000, null
            );
            if (profileResult && profileResult.changed_profiles) {
              var profiles = profileResult.changed_profiles;
              for (var i = 0; i < items.length; i++) {
                var conv = items[i];
                if (conv.isGroup || (conv.displayName && conv.displayName !== 'Không rõ tên')) continue;
                var cid = conv.id || conv.rawId || conv.userId;
                var profile = profiles[cid] || profiles[cid + '_0'] || profiles[normalizeMemberVersionKey(cid)];
                if (profile) {
                  items[i] = Object.assign({}, conv, {
                    displayName: profile.displayName || profile.zaloName || profile.username || profile.name || conv.displayName,
                    avatar: profile.avatar || profile.avatarUrl || conv.avatar,
                  });
                }
              }
            }
          } catch (e) {
            console.warn('[ZaloMain] getConversationList name resolution failed:', e.message);
          }
        }
      }

      return items;
    } catch (_) {
      return [];
    }
  }

  async function getMessageHistory(threadId, isGroup, count) {
    if (!initWebpackApi()) {
      console.warn('[ZaloMain] getMessageHistory: webpack API not ready');
      return [];
    }

    count = Number(count) || 20;
    var httpMod = _httpModule || _businessModule;
    var bizMod = _businessModule;

    if (!httpMod && !bizMod) {
      console.warn('[ZaloMain] getMessageHistory: no httpModule or businessModule available');
      return [];
    }

    // Log all available message-related methods (first time only)
    if (!getMessageHistory._loggedMethods) {
      getMessageHistory._loggedMethods = true;
      var mods = [
        { name: 'httpModule', mod: _httpModule },
        { name: 'businessModule', mod: _businessModule },
      ];
      for (var mi = 0; mi < mods.length; mi++) {
        if (!mods[mi].mod) continue;
        var allMethods = Object.keys(mods[mi].mod).filter(function (k) {
          return typeof mods[mi].mod[k] === 'function';
        }).sort();
        console.log('[ZaloMain]', mods[mi].name, 'ALL methods (' + allMethods.length + '):', allMethods.join(', '));
        var msgMethods = allMethods.filter(function (m) {
          return /msg|message|cm|history|chat|conv|cloud|sync|recent|fetch|load|get/i.test(m);
        });
        console.log('[ZaloMain]', mods[mi].name, 'data-related methods:', msgMethods.join(', '));
      }
      // Also log zStorage methods
      var zs = window.$$afmc && window.$$afmc.zStorage;
      if (zs) {
        var zsMethods = Object.keys(zs).filter(function (k) {
          return typeof zs[k] === 'function';
        }).sort();
        console.log('[ZaloMain] zStorage ALL methods (' + zsMethods.length + '):', zsMethods.join(', '));
      }
    }

    try {
      var result = null;
      var source = '';
      var allModules = [httpMod, bizMod].filter(function (m, i, arr) { return m && arr.indexOf(m) === i; });

      // Strategy 1: getCM with FULL 7 parameters
      for (var si = 0; si < allModules.length && !result; si++) {
        var mod = allModules[si];
        if (typeof mod.getCM !== 'function') continue;
        var modName = mod === _httpModule ? 'httpModule' : 'businessModule';
        console.log('[ZaloMain] getMessageHistory: trying', modName + '.getCM for', isGroup ? 'group' : '1:1', threadId);
        try {
          // getCM(conversationId, globalMsgId=0, unknownParam=0, count, reqId, timeout, opts)
          var reqId = Date.now();
          var cmPromise = mod.getCM(threadId, 0, 0, count, reqId, 10000, {});
          result = await withTimeout(cmPromise, 15000, null);
          if (result) source = modName + '.getCM';
        } catch (e) {
          console.warn('[ZaloMain]', modName + '.getCM threw:', e.message);
        }
      }

      // Strategy 2: getHistoryMessage (for groups especially)
      for (var si2 = 0; si2 < allModules.length && !result; si2++) {
        var mod2 = allModules[si2];
        if (typeof mod2.getHistoryMessage !== 'function') continue;
        var modName2 = mod2 === _httpModule ? 'httpModule' : 'businessModule';
        console.log('[ZaloMain] getMessageHistory: trying', modName2 + '.getHistoryMessage for', threadId);
        try {
          result = await withTimeout(mod2.getHistoryMessage(threadId, count), 12000, null);
          if (result) source = modName2 + '.getHistoryMessage';
        } catch (e) {
          console.warn('[ZaloMain]', modName2 + '.getHistoryMessage threw:', e.message);
        }
      }

      // Strategy 3: syncCloudMsgFirstLogin — bulk sync method
      for (var si3 = 0; si3 < allModules.length && !result; si3++) {
        var mod3 = allModules[si3];
        if (typeof mod3.syncCloudMsgFirstLogin !== 'function') continue;
        var modName3 = mod3 === _httpModule ? 'httpModule' : 'businessModule';
        console.log('[ZaloMain] getMessageHistory: trying', modName3 + '.syncCloudMsgFirstLogin for', threadId);
        try {
          result = await withTimeout(mod3.syncCloudMsgFirstLogin([threadId], 0), 12000, null);
          if (result) source = modName3 + '.syncCloudMsgFirstLogin';
        } catch (e) {
          console.warn('[ZaloMain]', modName3 + '.syncCloudMsgFirstLogin threw:', e.message);
        }
      }

      // Strategy 4: getCloudMessageJump — alternate fetch method
      for (var si4 = 0; si4 < allModules.length && !result; si4++) {
        var mod4 = allModules[si4];
        if (typeof mod4.getCloudMessageJump !== 'function') continue;
        var modName4 = mod4 === _httpModule ? 'httpModule' : 'businessModule';
        console.log('[ZaloMain] getMessageHistory: trying', modName4 + '.getCloudMessageJump for', threadId);
        try {
          var jumpReqId = Date.now();
          result = await withTimeout(mod4.getCloudMessageJump(threadId, 0, count, jumpReqId, false, 10000, {}), 12000, null);
          if (result) source = modName4 + '.getCloudMessageJump';
        } catch (e) {
          console.warn('[ZaloMain]', modName4 + '.getCloudMessageJump threw:', e.message);
        }
      }

      // Strategy 5: Scan ALL webpack modules for any with getCM or getMsg* methods
      if (!result && _wr && _wr.c) {
        console.log('[ZaloMain] getMessageHistory: scanning webpack cache for message modules...');
        var cacheKeys = Object.keys(_wr.c);
        for (var ck = 0; ck < cacheKeys.length && !result; ck++) {
          try {
            var cachedMod = _wr.c[cacheKeys[ck]];
            var exp = cachedMod && cachedMod.exports;
            var def = exp && (exp.default || exp);
            if (!def || def === httpMod || def === bizMod) continue;
            if (typeof def.getCM === 'function') {
              console.log('[ZaloMain] Found getCM on alternate module:', cacheKeys[ck]);
              try {
                var altReqId = Date.now();
                result = await withTimeout(def.getCM(threadId, 0, 0, count, altReqId, 10000, {}), 10000, null);
                if (result) source = 'altModule(' + cacheKeys[ck] + ').getCM';
              } catch (e2) {
                console.warn('[ZaloMain] altModule getCM threw:', e2.message);
              }
            }
          } catch (_) {}
        }
      }

      if (!result) {
        console.warn('[ZaloMain] getMessageHistory: all strategies returned null for', threadId);
        return [];
      }

      // Deep logging of the raw result
      console.log('[ZaloMain] getMessageHistory via', source, 'raw type:', typeof result);
      if (typeof result === 'object' && result !== null) {
        var topKeys = Object.keys(result);
        console.log('[ZaloMain] result keys:', topKeys.join(', '));
        try {
          var preview = JSON.stringify(result).slice(0, 800);
          console.log('[ZaloMain] result preview:', preview);
        } catch (_) {}
        if (result.data && typeof result.data === 'object') {
          console.log('[ZaloMain] result.data keys:', Object.keys(result.data).join(', '));
        }
        if (typeof result.data === 'string') {
          console.log('[ZaloMain] result.data is STRING, length:', result.data.length, 'first 100:', result.data.slice(0, 100));
        }
      }

      var msgs = extractMessages(result);
      console.log('[ZaloMain] extractMessages returned', msgs.length, 'raw items');
      if (msgs.length > 0 && msgs[0]) {
        console.log('[ZaloMain] first raw message keys:', Object.keys(msgs[0]).join(', '));
        try {
          console.log('[ZaloMain] first raw message preview:', JSON.stringify(msgs[0]).slice(0, 300));
        } catch (_) {}
      }

      var arr = msgs.map(normalizeMessage).filter(Boolean);
      console.log('[ZaloMain] getMessageHistory final:', arr.length, 'messages from', source);
      return arr;
    } catch (err) {
      console.error('[ZaloMain] getMessageHistory error:', err.message || err);
      return [];
    }
  }

  // Extract message array from various Zalo API response shapes
  function extractMessages(result) {
    if (!result) return [];

    function extractFromParsedEnvelope(parsed) {
      if (!parsed || typeof parsed !== 'object') return [];
      if (Array.isArray(parsed.msgs)) return parsed.msgs;
      if (Array.isArray(parsed.groupMsgs)) return parsed.groupMsgs;
      if (Array.isArray(parsed.messages)) return parsed.messages;
      if (parsed.data && typeof parsed.data === 'object') {
        if (Array.isArray(parsed.data.msgs)) return parsed.data.msgs;
        if (Array.isArray(parsed.data.groupMsgs)) return parsed.data.groupMsgs;
        if (Array.isArray(parsed.data.messages)) return parsed.data.messages;
      }
      return [];
    }

    function tryDecodeEnvelope(payload, label) {
      if (typeof payload !== 'string' || payload.length <= 10) return [];
      if (!_encoderModule || typeof _encoderModule.decodeAES !== 'function') return [];
      try {
        var decrypted = _encoderModule.decodeAES(payload);
        if (!decrypted) return [];
        var parsed = JSON.parse(decrypted);
        console.log('[ZaloMain] extractMessages: decrypted ' + label + ', keys:', Object.keys(parsed));
        return extractFromParsedEnvelope(parsed);
      } catch (e) {
        console.warn('[ZaloMain] extractMessages: AES decrypt failed for ' + label + ':', e.message);
        return [];
      }
    }

    // Most Zalo APIs return { msgs: [...] } or { groupMsgs: [...] }
    if (Array.isArray(result.msgs)) return result.msgs;
    if (Array.isArray(result.groupMsgs)) return result.groupMsgs;
    // Handle two-layer response: { error_code, data: { msgs: [...] } }
    if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
      if (Array.isArray(result.data.msgs)) return result.data.msgs;
      if (Array.isArray(result.data.groupMsgs)) return result.data.groupMsgs;
      if (Array.isArray(result.data.messages)) return result.data.messages;
      // Triple-nested: result.data.data.msgs
      if (result.data.data && typeof result.data.data === 'object') {
        if (Array.isArray(result.data.data.msgs)) return result.data.data.msgs;
        if (Array.isArray(result.data.data.groupMsgs)) return result.data.data.groupMsgs;
      }

      // Axios-style envelope: { data: { error_code, data: '<encrypted>' } }
      if (typeof result.data.data === 'string') {
        var axiosDecoded = tryDecodeEnvelope(result.data.data, 'result.data.data');
        if (axiosDecoded.length) return axiosDecoded;
      }
    }
    // Handle AES-encrypted data string: { error_code, data: "<encrypted>" }
    if (typeof result.data === 'string') {
      var decoded = tryDecodeEnvelope(result.data, 'result.data');
      if (decoded.length) return decoded;
    }
    if (Array.isArray(result.data)) return result.data;
    if (Array.isArray(result.messages)) return result.messages;
    // If result itself is an array
    if (Array.isArray(result)) return result;
    // Don't use toArray — it converts metadata fields into fake messages
    return [];
  }

  function normalizeMessage(msg) {
    if (!msg || typeof msg !== 'object') return null;
    if (typeof msg === 'number' || typeof msg === 'string') return null;
    // Must have at least one message-like field
    if (!msg.msgId && !msg.globalMsgId && !msg.actionId && !msg.cliMsgId && !msg.uidFrom && !msg.fromUid && !msg.content && !msg.msg && !msg.message) return null;

    var content = extractMessageContent(msg) || '[Tin nhắn không có nội dung]';

    // Zalo uses "0" to mean "self" for both uidFrom and idTo
    var fromId = String(msg.uidFrom || msg.fromUid || msg.fromId || msg.senderId || msg.uid || '');
    var toId = String(msg.idTo || msg.toId || msg.toUid || '');
    
    // Generate unique message ID from available fields
    var msgId = String(msg.msgId || msg.globalMsgId || msg.actionId || msg.realMsgId || msg.cliMsgId || msg.id || '');
    
    // If still no msgId, generate one from content hash
    if (!msgId) {
      msgId = 'gen_' + (msg.ts || Date.now()) + '_' + (fromId || 'x') + '_' + Math.random().toString(36).substr(2, 6);
    }

    var ts = Number(msg.ts || msg.sendDttm || msg.createTime || msg.time || 0);
    // Zalo sometimes returns ts as a string
    if (typeof msg.ts === 'string' && msg.ts.length > 0) {
      ts = Number(msg.ts);
    }

    return {
      msgId: msgId,
      fromId: fromId,
      toId: toId,
      content: content,
      rawContent: getRawMessageContent(msg),
      ts: ts,
      msgType: msg.msgType || msg.type || 'text',
      status: msg.status || 0,
      cliMsgId: String(msg.cliMsgId || ''),
      dName: msg.dName || '',
      quote: msg.quote || null,
    };
  }

  async function getConversationPreview(toId) {
    var zs = window.$$afmc && window.$$afmc.zStorage;
    if (!zs || typeof zs.getConversations !== 'function' || !toId) {
      return null;
    }

    var normalizedToId = normalizeConversationId(toId, true);

    try {
      var conversations = await withTimeout(zs.getConversations(), 1500, []);
      var items = toArray(conversations);
      var match = items.find(function (conversation) {
        if (!conversation) return false;
        var conversationIds = [
          conversation.userId,
          conversation.id,
          conversation.globalId,
          conversation.convId,
          conversation.groupId,
        ].map(function (value) {
          return normalizeConversationId(value, true);
        });

        return conversationIds.indexOf(normalizedToId) !== -1;
      });

      if (!match) return null;
      return {
        id: match.userId || match.id || match.globalId || '',
        lastMsg: getConversationLastMessage(match),
        lastMsgTime: match.lastMsgTime || match.actionTime || match.lastActionTime || 0,
      };
    } catch (_) {
      return null;
    }
  }

  function chunkArray(items, size) {
    var result = [];
    for (var index = 0; index < items.length; index += size) {
      result.push(items.slice(index, index + size));
    }
    return result;
  }

  function normalizeMemberVersionKey(value) {
    var text = String(value || '').trim();
    if (!text) return '';
    if (text.indexOf('_') !== -1) return text;
    return text + '_0';
  }

  function extractGroupMemberIds(group) {
    var ids = [];
    var seen = new Set();

    function pushId(value) {
      var text = String(value || '').trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      ids.push(text);
    }

    if (Array.isArray(group && group.memberIds)) {
      group.memberIds.forEach(pushId);
    }

    if (Array.isArray(group && group.currentMems)) {
      group.currentMems.forEach(function (item) {
        if (item && typeof item === 'object') {
          pushId(item.id || item.userId || item.uid);
        } else {
          pushId(item);
        }
      });
    }

    if (Array.isArray(group && group.updateMems)) {
      group.updateMems.forEach(function (item) {
        if (item && typeof item === 'object') {
          pushId(item.id || item.userId || item.uid);
        } else {
          pushId(item);
        }
      });
    }

    if (Array.isArray(group && group.memVerList)) {
      group.memVerList.forEach(pushId);
    }

    return ids;
  }

  function indexProfileByKey(target, source) {
    Object.entries(source || {}).forEach(function (entry) {
      var key = entry[0];
      var profile = entry[1];
      target[key] = profile;
      var plain = String(key || '').replace(/_\d+$/, '');
      if (plain && plain !== key) {
        target[plain] = profile;
      } else if (plain) {
        target[plain + '_0'] = profile;
      }
    });
  }

  function buildFriendIdentifierSet(friends) {
    var identifiers = new Set();
    toArray(friends).forEach(function (friend) {
      [friend && friend.userId, friend && friend.username, friend && friend.globalId].forEach(function (value) {
        var text = String(value || '').trim();
        if (text) identifiers.add(text);
      });
    });
    return identifiers;
  }

  function normalizeLookupQuery(value) {
    return String(value || '').trim();
  }

  function normalizePhoneLookupValue(value) {
    var text = normalizeLookupQuery(value).replace(/[\s().-]/g, '');
    if (!text) return '';
    if (text.charAt(0) === '+') {
      text = text.slice(1);
    }
    if (text.charAt(0) === '0') {
      return '84' + text.slice(1);
    }
    return text;
  }

  function looksLikePhoneLookup(value) {
    return /^\+?\d{8,15}$/.test(normalizeLookupQuery(value).replace(/[\s().-]/g, ''));
  }

  function addLookupKey(target, key, value) {
    var text = normalizeLookupQuery(key);
    if (!text || target.has(text)) return;
    target.set(text, value);
  }

  function buildFriendLookupMap(friends) {
    var lookup = new Map();
    toArray(friends).forEach(function (friend) {
      var normalized = normalizeFriend(friend) || friend;
      if (!normalized) return;
      addLookupKey(lookup, normalized.userId, normalized);
      addLookupKey(lookup, normalized.username, normalized);
      addLookupKey(lookup, normalized.globalId, normalized);
      addLookupKey(lookup, normalized.phoneNumber, normalized);
      addLookupKey(lookup, normalizePhoneLookupValue(normalized.phoneNumber), normalized);
    });
    return lookup;
  }

  function buildResolvedUserRecord(query, payload) {
    return {
      query: query,
      phone: query,
      found: true,
      uid: String(payload && (payload.uid || payload.userId || payload.id) || '').trim(),
      displayName: String(payload && (payload.displayName || payload.display_name || payload.zaloName || payload.zalo_name) || '').trim(),
      zaloName: String(payload && (payload.zaloName || payload.zalo_name || payload.displayName || payload.display_name) || '').trim(),
      avatar: String(payload && payload.avatar || '').trim(),
      gender: payload && payload.gender || '',
      status: String(payload && payload.status || '').trim(),
      globalId: String(payload && payload.globalId || '').trim(),
      isFr: Number(payload && payload.isFr) === 1,
    };
  }

  async function lookupUserProfileById(query) {
    var text = normalizeLookupQuery(query);
    if (!text) return null;

    var userInfoResponse = await withTimeout(
      callFirstAvailableMethod(['getUserInfo'], [[text, normalizeMemberVersionKey(text)]]),
      12000,
      { changed_profiles: {} }
    );
    var userInfoMap = {};
    indexProfileByKey(userInfoMap, userInfoResponse && userInfoResponse.changed_profiles);
    var profile = userInfoMap[text] || userInfoMap[normalizeMemberVersionKey(text)] || null;
    if (!profile) return null;

    return buildResolvedUserRecord(query, {
      uid: profile.userId || profile.id || text,
      displayName: profile.displayName || profile.zaloName || '',
      zaloName: profile.zaloName || profile.displayName || '',
      avatar: profile.avatar || '',
      gender: profile.gender || '',
      status: profile.status || '',
      globalId: profile.globalId || '',
      isFr: profile.isFr,
    });
  }

  async function findUserByPhoneQuery(query) {
    var phoneQuery = normalizePhoneLookupValue(query);
    if (!phoneQuery || !looksLikePhoneLookup(query)) return null;

    var result = await withTimeout(callFirstAvailableMethod(['findUser'], [phoneQuery]), 12000, null);
    if (!result || !result.uid) return null;

    return buildResolvedUserRecord(query, {
      uid: result.uid,
      displayName: result.display_name || result.zalo_name || '',
      zaloName: result.zalo_name || result.display_name || '',
      avatar: result.avatar || '',
      gender: result.gender || '',
      status: result.status || '',
      globalId: result.globalId || '',
      isFr: result.isFr,
    });
  }

  async function resolveUserTargets(args) {
    if (!initWebpackApi()) {
      throw new Error('Webpack API chưa sẵn sàng. Trang Zalo có thể chưa tải xong.');
    }

    var queries = Array.isArray(args && args.queries)
      ? args.queries.map(normalizeLookupQuery).filter(Boolean).slice(0, 100)
      : [];

    if (!queries.length) {
      return { results: [] };
    }

    var zs = window.$$afmc && window.$$afmc.zStorage;
    var me = null;
    try {
      me = zs && typeof zs.getMe === 'function' ? await withTimeout(zs.getMe(), 1500, null) : null;
    } catch (_) {
      me = null;
    }

    var accountUserId = String((args && args.accountUserId) || (me && me.userId) || buildSessionSnapshot().userId || '').trim();

    var friends = [];
    try {
      friends = zs && typeof zs.getFriends === 'function' ? await withTimeout(zs.getFriends(), 1500, []) : [];
    } catch (_) {
      friends = [];
    }

    var friendLookup = buildFriendLookupMap(friends);
    var results = [];

    for (var index = 0; index < queries.length; index += 1) {
      var query = queries[index];
      var friendMatch = friendLookup.get(query) || friendLookup.get(normalizePhoneLookupValue(query)) || null;

      if (friendMatch) {
        var friendRecord = buildResolvedUserRecord(query, {
          uid: friendMatch.userId || friendMatch.id,
          displayName: friendMatch.displayName || friendMatch.zaloName || '',
          zaloName: friendMatch.zaloName || friendMatch.displayName || '',
          avatar: friendMatch.avatar || '',
          gender: friendMatch.gender || '',
          status: friendMatch.status || '',
          globalId: friendMatch.globalId || '',
          isFr: friendMatch.isFr,
        });

        if (!friendRecord.uid || friendRecord.uid === accountUserId) {
          results.push({ query: query, phone: query, found: false, error: 'Đây là tài khoản hiện tại.' });
        } else {
          results.push(friendRecord);
        }
        continue;
      }

      var directProfile = null;
      try {
        directProfile = await lookupUserProfileById(query);
      } catch (_) {
        directProfile = null;
      }

      if (directProfile && directProfile.uid) {
        if (directProfile.uid === accountUserId) {
          results.push({ query: query, phone: query, found: false, error: 'Đây là tài khoản hiện tại.' });
        } else {
          results.push(directProfile);
        }
        continue;
      }

      var phoneProfile = null;
      try {
        phoneProfile = await findUserByPhoneQuery(query);
      } catch (error) {
        results.push({
          query: query,
          phone: query,
          found: false,
          error: error instanceof Error ? error.message : 'Lỗi khi tra cứu tài khoản.',
        });
        continue;
      }

      if (phoneProfile && phoneProfile.uid) {
        if (phoneProfile.uid === accountUserId) {
          results.push({ query: query, phone: query, found: false, error: 'Đây là tài khoản hiện tại.' });
        } else {
          results.push(phoneProfile);
        }
        continue;
      }

      results.push({ query: query, phone: query, found: false, error: 'Không tìm thấy tài khoản Zalo.' });
    }

    return { results: results };
  }

  function extractGroupInfoMap(result, fallbackGroups) {
    if (result && result.gridInfoMap && typeof result.gridInfoMap === 'object') {
      return result.gridInfoMap;
    }

    if (result && result.data && result.data.gridInfoMap && typeof result.data.gridInfoMap === 'object') {
      return result.data.gridInfoMap;
    }

    var map = {};
    toArray(result).forEach(function (group) {
      var key = normalizeConversationId(group && (group.groupId || group.userId || group.id), true);
      if (key) map[key] = group;
    });

    if (Object.keys(map).length > 0) {
      return map;
    }

    toArray(fallbackGroups).forEach(function (group) {
      var key = normalizeConversationId(group && (group.userId || group.groupId || group.id), true);
      if (key) map[key] = group;
    });
    return map;
  }

  async function callFirstAvailableMethod(methodNames, args) {
    var owners = [_httpModule, _businessModule].filter(Boolean);
    var lastError = null;

    for (var ownerIndex = 0; ownerIndex < owners.length; ownerIndex += 1) {
      var owner = owners[ownerIndex];
      for (var methodIndex = 0; methodIndex < methodNames.length; methodIndex += 1) {
        var methodName = methodNames[methodIndex];
        if (typeof owner[methodName] !== 'function') continue;
        try {
          return await owner[methodName].apply(owner, args || []);
        } catch (error) {
          lastError = error;
        }
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error('Không tìm thấy phương thức Zalo phù hợp: ' + methodNames.join(', '));
  }

  async function resolveGroupMembers(args) {
    if (!initWebpackApi()) {
      throw new Error('Webpack API chưa sẵn sàng. Trang Zalo có thể chưa tải xong.');
    }

    var groups = Array.isArray(args && args.groups) ? args.groups : [];
    var groupIds = groups
      .map(function (group) {
        if (group && typeof group === 'object') {
          return normalizeConversationId(group.groupId || group.zid || group.userId || group.id, true);
        }
        return normalizeConversationId(group, true);
      })
      .filter(Boolean);

    if (!groupIds.length) {
      return { membersByGroup: {} };
    }

    var zs = window.$$afmc && window.$$afmc.zStorage;
    var me = null;
    try {
      me = zs && typeof zs.getMe === 'function' ? await withTimeout(zs.getMe(), 1500, null) : null;
    } catch (_) {
      me = null;
    }

    var friends = [];
    try {
      friends = zs && typeof zs.getFriends === 'function' ? await withTimeout(zs.getFriends(), 3000, []) : [];
    } catch (_) {
      friends = [];
    }
    console.log('[ZaloMain] resolveGroupMembers: friends loaded:', friends.length);

    // Build userId → friend profile map for name resolution
    var friendProfileMap = {};
    toArray(friends).forEach(function (friend) {
      var normalized = normalizeFriend(friend) || friend;
      if (!normalized) return;
      var uid = String(normalized.userId || '').trim();
      if (uid) {
        friendProfileMap[uid] = normalized;
        friendProfileMap[uid + '_0'] = normalized;
      }
    });

    // Load RAW groups from zStorage (not normalized, to preserve currentMems/memVerList)
    var rawZStorageGroups = [];
    try {
      rawZStorageGroups = zs && typeof zs.getGroups === 'function'
        ? toArray(await withTimeout(zs.getGroups(), 3000, []))
        : [];
    } catch (_) {
      rawZStorageGroups = [];
    }
    console.log('[ZaloMain] rawZStorageGroups:', rawZStorageGroups.length);

    var accountUserId = String((args && args.accountUserId) || (me && me.userId) || buildSessionSnapshot().userId || '').trim();
    var existingFriendIds = buildFriendIdentifierSet(friends);

    // With the decodeAES hook active (installed in initWebpackApi), lockViewMember
    // is already set to 0 in ALL group API responses. So getGroupInfos will
    // return the full member list even for locked groups.
    var groupInfoMap = {};

    function extractGridInfoMap(resp) {
      if (!resp) return null;
      if (resp.gridInfoMap && typeof resp.gridInfoMap === 'object') return resp.gridInfoMap;
      if (resp.data && resp.data.gridInfoMap && typeof resp.data.gridInfoMap === 'object') return resp.data.gridInfoMap;
      return null;
    }

    // Verify decodeAES hook is active
    if (_encoderModule && _encoderModule._zalotool_hooked) {
      console.log('[ZaloMain] decodeAES hook confirmed active');
    } else {
      console.warn('[ZaloMain] decodeAES hook NOT active — will use raw HTTP fallback');
    }

    // Strategy 1: Call getGroupInfos (with decodeAES hook if active)
    var apiSuccess = false;
    var mpage = 1;
    var maxPages = 10;
    var mcount = 500;

    for (var page = 0; page < maxPages; page += 1) {
      try {
        var resp = await withTimeout(
          callFirstAvailableMethod(['getGroupInfos', 'getGroupInfo'], [groupIds, mpage + page, mcount]),
          15000, null
        );
        var gmap = extractGridInfoMap(resp);
        console.log('[ZaloMain] getGroupInfos page', mpage + page, 'result:', gmap ? Object.keys(gmap).length + ' groups' : 'null');

        if (!gmap || !Object.keys(gmap).length) break;

        apiSuccess = true;
        Object.keys(gmap).forEach(function (gid) {
          var gdata = gmap[gid];
          if (!groupInfoMap[gid]) {
            groupInfoMap[gid] = gdata;
          } else {
            // Merge additional members from subsequent pages
            var existing = groupInfoMap[gid];
            if (Array.isArray(gdata.currentMems) && gdata.currentMems.length) {
              existing.currentMems = (existing.currentMems || []).concat(gdata.currentMems);
            }
            if (Array.isArray(gdata.memVerList) && gdata.memVerList.length) {
              existing.memVerList = (existing.memVerList || []).concat(gdata.memVerList);
            }
            if (Array.isArray(gdata.memberIds) && gdata.memberIds.length) {
              existing.memberIds = (existing.memberIds || []).concat(gdata.memberIds);
            }
          }
        });

        // Check hasMoreMember for any group
        var hasMore = false;
        Object.keys(gmap).forEach(function (gid) {
          if (Number(gmap[gid].hasMoreMember) > 0) hasMore = true;
        });
        if (!hasMore) break;
        console.log('[ZaloMain] hasMoreMember detected, fetching page', mpage + page + 1);
      } catch (e) {
        console.warn('[ZaloMain] getGroupInfos page', mpage + page, 'failed:', e.message);
        break;
      }
    }

    // Check if we got enough members — if not, try raw HTTP fallback
    var needsRawFallback = false;
    if (!apiSuccess) {
      needsRawFallback = true;
      console.log('[ZaloMain] getGroupInfos returned nothing, trying raw HTTP');
    } else {
      // Check if any group returned far fewer members than totalMember
      Object.keys(groupInfoMap).forEach(function (gid) {
        var g = groupInfoMap[gid];
        var totalFromApi = (g.currentMems || []).length + (g.memVerList || []).length;
        var total = Number(g.totalMember) || 0;
        if (total > 10 && totalFromApi < total * 0.5) {
          needsRawFallback = true;
          console.log('[ZaloMain] Group', gid, 'has', totalFromApi, 'members from API but totalMember is', total, '— needs raw fallback');
        }
      });
    }

    // Strategy 2: Raw HTTP fetch — bypass Zalo's client-side filtering entirely
    // Same approach as zalo-api-final: encodeAES → fetch → decodeAES
    if (needsRawFallback && _encoderModule && typeof _encoderModule.encodeAES === 'function') {
      console.log('[ZaloMain] Attempting raw HTTP to /api/group/getmg-v2...');
      try {
        // Build gridVerMap: {groupId: 0, ...}
        var gridVerMap = {};
        groupIds.forEach(function (gid) { gridVerMap[gid] = 0; });
        var rawParams = JSON.stringify({ gridVerMap: JSON.stringify(gridVerMap) });
        var encryptedParams = _encoderModule.encodeAES(rawParams);

        if (!encryptedParams) {
          console.warn('[ZaloMain] encodeAES returned null');
        } else {
          // Find the group API domain from zpwServiceMap or network
          var groupDomains = [];
          // Try to get zpwServiceMap from _httpModule internals
          try {
            if (_httpModule && _httpModule._zpwServiceMap) {
              var smap = _httpModule._zpwServiceMap;
              if (smap.group && Array.isArray(smap.group)) groupDomains = smap.group;
            }
          } catch (_) {}

          // Search webpack modules for zpwServiceMap
          if (!groupDomains.length && _wr && _wr.c) {
            var wrCache = _wr.c;
            var wrKeys = Object.keys(wrCache);
            for (var wki = 0; wki < wrKeys.length && !groupDomains.length; wki++) {
              try {
                var wmod = wrCache[wrKeys[wki]];
                var wexp = wmod && wmod.exports;
                if (!wexp) continue;
                var smap2 = wexp.zpwServiceMap || wexp.default && wexp.default.zpwServiceMap ||
                            wexp.zpw_service_map_v3 || wexp.default && wexp.default.zpw_service_map_v3;
                if (smap2 && smap2.group && Array.isArray(smap2.group)) {
                  groupDomains = smap2.group;
                  console.log('[ZaloMain] Found zpwServiceMap.group from webpack cache key:', wrKeys[wki]);
                }
              } catch (_) {}
            }
          }

          // Try localStorage/sessionStorage for zpw_service_map
          if (!groupDomains.length) {
            [window.localStorage, window.sessionStorage].forEach(function (storage) {
              if (!storage || groupDomains.length) return;
              for (var si = 0; si < storage.length; si++) {
                try {
                  var sk = storage.key(si);
                  var sv = storage.getItem(sk);
                  if (sv && sv.indexOf('zpw_service_map') !== -1) {
                    var parsed = JSON.parse(sv);
                    var m = parsed.zpw_service_map_v3 || parsed;
                    if (m.group && Array.isArray(m.group)) {
                      groupDomains = m.group;
                      console.log('[ZaloMain] Found zpwServiceMap.group from storage key:', sk);
                    }
                  }
                } catch (_) {}
              }
            });
          }

          // Fallback: monitor network requests that went to group API
          if (!groupDomains.length) {
            // Try common group API domains from performance entries
            try {
              var perfEntries = performance.getEntriesByType('resource');
              for (var pi = 0; pi < perfEntries.length; pi++) {
                var pUrl = perfEntries[pi].name || '';
                if (pUrl.indexOf('/api/group/') !== -1) {
                  var domainMatch = pUrl.match(/^(https?:\/\/[^/]+)/);
                  if (domainMatch) {
                    groupDomains.push(domainMatch[1]);
                    console.log('[ZaloMain] Found group domain from performance API:', domainMatch[1]);
                    break;
                  }
                }
              }
            } catch (_) {}
          }

          // Get common URL params (zpw_ver, zpw_type)
          var commonQs = '';
          try {
            if (_httpModule && typeof _httpModule._getCommonParams === 'function') {
              commonQs = _httpModule._getCommonParams();
            }
          } catch (_) {}
          if (!commonQs) commonQs = 'zpw_ver=645&zpw_type=30';

          if (groupDomains.length) {
            for (var gdi = 0; gdi < groupDomains.length; gdi++) {
              try {
                var rawUrl = groupDomains[gdi] + '/api/group/getmg-v2?' + commonQs;
                console.log('[ZaloMain] raw HTTP fetch to:', rawUrl.substring(0, 80));

                var rawResponse = await withTimeout(
                  fetch(rawUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'params=' + encodeURIComponent(encryptedParams),
                    credentials: 'include',
                  }).then(function (r) { return r.json(); }),
                  20000, null
                );

                console.log('[ZaloMain] raw HTTP response:', rawResponse ? 'error_code=' + rawResponse.error_code : 'null');

                if (rawResponse && rawResponse.error_code === 0 && rawResponse.data) {
                  // Decrypt the response data
                  var decryptedStr = null;
                  if (!_encoderModule) {
                    console.warn('[ZaloMain] raw HTTP: encoder module not available for decrypt');
                    continue;
                  }
                  var decFn = _encoderModule.decodeAES; // Use hooked version for lockViewMember bypass
                  if (typeof decFn === 'function') {
                    decryptedStr = decFn(rawResponse.data, 0);
                  }

                  if (decryptedStr) {
                    var decryptedJson = JSON.parse(decryptedStr);
                    console.log('[ZaloMain] raw HTTP decrypted, error_code:', decryptedJson.error_code);

                    var rawGridMap = null;
                    if (decryptedJson.data && decryptedJson.data.gridInfoMap) {
                      rawGridMap = decryptedJson.data.gridInfoMap;
                    } else if (decryptedJson.gridInfoMap) {
                      rawGridMap = decryptedJson.gridInfoMap;
                    }

                    if (rawGridMap) {
                      apiSuccess = true;
                      Object.keys(rawGridMap).forEach(function (gid) {
                        var g = rawGridMap[gid];
                        // Force unlock lockViewMember since we control the data
                        if (g && g.setting) g.setting.lockViewMember = 0;
                        groupInfoMap[gid] = g;
                      });
                      console.log('[ZaloMain] raw HTTP got', Object.keys(rawGridMap).length, 'groups');
                      Object.keys(rawGridMap).forEach(function (gid) {
                        var rg = rawGridMap[gid];
                        console.log('[ZaloMain] raw group', gid,
                          'totalMember:', rg.totalMember,
                          'currentMems:', (rg.currentMems || []).length,
                          'memVerList:', (rg.memVerList || []).length,
                          'memberIds:', (rg.memberIds || []).length);
                      });
                      break; // Success, no need to try other domains
                    }
                  } else {
                    console.warn('[ZaloMain] raw HTTP: decodeAES returned null');
                  }
                }
              } catch (e) {
                console.warn('[ZaloMain] raw HTTP domain', groupDomains[gdi], 'failed:', e.message);
              }
            }
          } else {
            console.warn('[ZaloMain] Could not find group API domain for raw HTTP');
          }
        }
      } catch (e) {
        console.warn('[ZaloMain] raw HTTP fallback failed:', e.message, e.stack);
      }
    }

    // Log what we got from API
    Object.keys(groupInfoMap).forEach(function (gid) {
      var g = groupInfoMap[gid];
      console.log('[ZaloMain] API group', gid,
        'totalMember:', g.totalMember,
        'currentMems:', (g.currentMems || []).length,
        'memVerList:', (g.memVerList || []).length,
        'memberIds:', (g.memberIds || []).length,
        'hasMoreMember:', g.hasMoreMember,
        'lockViewMember:', g.setting && g.setting.lockViewMember);
    });

    // Fallback: match from raw zStorage groups (preserves currentMems, memberIds, etc.)
    if (!Object.keys(groupInfoMap).length) {
      console.log('[ZaloMain] API groupInfoMap empty, trying zStorage raw groups');
      rawZStorageGroups.forEach(function (group) {
        var key = normalizeConversationId(group && (group.userId || group.groupId || group.id), true);
        if (key && !groupInfoMap[key]) {
          groupInfoMap[key] = group;
        }
      });
    }

    // Also merge zStorage data if API returned fewer currentMems than totalMember
    rawZStorageGroups.forEach(function (rawGroup) {
      var key = normalizeConversationId(rawGroup && (rawGroup.userId || rawGroup.groupId || rawGroup.id), true);
      if (!key || !groupInfoMap[key]) return;
      var apiGroup = groupInfoMap[key];
      var apiMems = (apiGroup.currentMems || []).length;
      var rawMems = (rawGroup.currentMems || []).length;
      if (rawMems > apiMems) {
        console.log('[ZaloMain] zStorage has more currentMems for', key, ':', rawMems, 'vs API:', apiMems);
        apiGroup.currentMems = rawGroup.currentMems;
      }
      // Also supplement memVerList
      if ((rawGroup.memVerList || []).length > (apiGroup.memVerList || []).length) {
        apiGroup.memVerList = rawGroup.memVerList;
      }
    });

    console.log('[ZaloMain] final groupInfoMap keys:', Object.keys(groupInfoMap).join(', '));
    var membersByGroup = {};

    for (var groupIndex = 0; groupIndex < groupIds.length; groupIndex += 1) {
      var groupId = groupIds[groupIndex];
      var group = groupInfoMap[groupId] || groupInfoMap['g' + groupId] || null;

      // Fallback: search raw zStorage groups by ID
      if (!group) {
        for (var fbIdx = 0; fbIdx < rawZStorageGroups.length; fbIdx += 1) {
          var fbGroup = rawZStorageGroups[fbIdx];
          var fbId = normalizeConversationId(fbGroup && (fbGroup.userId || fbGroup.groupId || fbGroup.id), true);
          if (fbId === groupId) {
            group = fbGroup;
            break;
          }
        }
      }

      if (!group) {
        console.warn('[ZaloMain] group not found:', groupId);
        membersByGroup[groupId] = [];
        continue;
      }

      // Log raw group structure for debugging
      console.log('[ZaloMain] group found:', groupId,
        'name:', group.name || group.displayName,
        'memberIds:', (group.memberIds || []).length,
        'currentMems:', (group.currentMems || []).length,
        'memVerList:', (group.memVerList || []).length,
        'updateMems:', (group.updateMems || []).length,
        'totalMember:', group.totalMember);

      // Log a sample currentMem to see its structure
      if (Array.isArray(group.currentMems) && group.currentMems.length > 0) {
        console.log('[ZaloMain] sample currentMem[0]:', JSON.stringify(group.currentMems[0]).slice(0, 300));
      }

      var adminIds = Array.isArray(group.adminIds) ? group.adminIds : (Array.isArray(group.admin_ids) ? group.admin_ids : []);
      var adminIdSet = new Set(adminIds.map(function (id) { return String(id || '').trim(); }).filter(Boolean));
      var creatorId = String(group.creatorId || group.ownerId || group.creator || '').trim();
      var memberVersionKeys = extractGroupMemberIds(group).map(normalizeMemberVersionKey).filter(Boolean);

      if (!memberVersionKeys.length) {
        console.warn('[ZaloMain] no member IDs extracted for group:', groupId);
        membersByGroup[groupId] = [];
        continue;
      }

      console.log('[ZaloMain] memberVersionKeys:', memberVersionKeys.length,
        'sample:', memberVersionKeys.slice(0, 5).join(', '));

      // Build currentMems lookup (dName from getGroupInfo is the most reliable name source)
      var currentMemsMap = {};
      if (Array.isArray(group.currentMems)) {
        group.currentMems.forEach(function (mem) {
          if (!mem || typeof mem !== 'object') return;
          var id = String(mem.id || mem.userId || mem.uid || '').trim();
          if (!id) return;
          currentMemsMap[id] = mem;
          currentMemsMap[id + '_0'] = mem;
        });
      }
      console.log('[ZaloMain] currentMemsMap entries:', Object.keys(currentMemsMap).length);

      // Fetch enriched profiles via API calls (best-effort, may fail)
      var groupProfileMap = {};
      var userInfoMap = {};
      var profileChunks = chunkArray(memberVersionKeys, 200);

      for (var chunkIndex = 0; chunkIndex < profileChunks.length; chunkIndex += 1) {
        var ids = profileChunks[chunkIndex];
        if (!ids.length) continue;

        // Normalize IDs to have _0 suffix for friend_pversion_map
        var versionedIds = ids.map(function (id) {
          return id.endsWith('_0') ? id : id + '_0';
        });

        // Try getGroupMembersInfo via webpack API
        var groupMembersResponse = null;
        try {
          groupMembersResponse = await withTimeout(callFirstAvailableMethod(['getGroupMembersInfo'], [versionedIds]), 12000, null);
          if (groupMembersResponse) {
            var gmProfiles = groupMembersResponse.profiles || {};
            console.log('[ZaloMain] getGroupMembersInfo OK, profiles:', Object.keys(gmProfiles).length);
            if (Object.keys(gmProfiles).length > 0) {
              console.log('[ZaloMain] sample gmProfile:', JSON.stringify(Object.values(gmProfiles)[0]).slice(0, 300));
            }
            indexProfileByKey(groupProfileMap, gmProfiles);
          } else {
            console.log('[ZaloMain] getGroupMembersInfo returned null');
          }
        } catch (e) {
          console.warn('[ZaloMain] getGroupMembersInfo failed:', e.message);
        }

        // Try getUserInfo
        var userInfoResponse = null;
        try {
          userInfoResponse = await withTimeout(callFirstAvailableMethod(['getUserInfo'], [ids]), 12000, null);
          if (userInfoResponse) {
            var uiProfiles = userInfoResponse.changed_profiles || {};
            console.log('[ZaloMain] getUserInfo OK, profiles:', Object.keys(uiProfiles).length);
            if (Object.keys(uiProfiles).length > 0) {
              console.log('[ZaloMain] sample uiProfile:', JSON.stringify(Object.values(uiProfiles)[0]).slice(0, 300));
            }
            indexProfileByKey(userInfoMap, uiProfiles);
          } else {
            console.log('[ZaloMain] getUserInfo returned null');
          }
        } catch (e) {
          console.warn('[ZaloMain] getUserInfo failed:', e.message);
        }

        // Raw HTTP fallback for getGroupMembersInfo if we got few profiles
        if (Object.keys(groupProfileMap).length < ids.length * 0.3 &&
            _encoderModule && typeof _encoderModule.encodeAES === 'function') {
          try {
            var profileParams = JSON.stringify({ friend_pversion_map: versionedIds });
            var encProfileParams = _encoderModule.encodeAES(profileParams);
            if (encProfileParams) {
              // Find profile API domain
              var profileDomains = [];
              if (!profileDomains.length && _wr && _wr.c) {
                var prCache = _wr.c;
                var prKeys = Object.keys(prCache);
                for (var pri = 0; pri < prKeys.length && !profileDomains.length; pri++) {
                  try {
                    var prmod = prCache[prKeys[pri]];
                    var prexp = prmod && prmod.exports;
                    if (!prexp) continue;
                    var sm = prexp.zpwServiceMap || prexp.default && prexp.default.zpwServiceMap ||
                             prexp.zpw_service_map_v3 || prexp.default && prexp.default.zpw_service_map_v3;
                    if (sm && sm.profile && Array.isArray(sm.profile)) {
                      profileDomains = sm.profile;
                    }
                  } catch (_) {}
                }
              }
              // Also try localStorage
              if (!profileDomains.length) {
                [window.localStorage, window.sessionStorage].forEach(function (storage) {
                  if (!storage || profileDomains.length) return;
                  for (var si = 0; si < storage.length; si++) {
                    try {
                      var sk = storage.key(si);
                      var sv = storage.getItem(sk);
                      if (sv && sv.indexOf('zpw_service_map') !== -1) {
                        var parsed = JSON.parse(sv);
                        var m2 = parsed.zpw_service_map_v3 || parsed;
                        if (m2.profile && Array.isArray(m2.profile)) profileDomains = m2.profile;
                      }
                    } catch (_) {}
                  }
                });
              }
              // Try performance API
              if (!profileDomains.length) {
                try {
                  var pe = performance.getEntriesByType('resource');
                  for (var pei = 0; pei < pe.length; pei++) {
                    var pu = pe[pei].name || '';
                    if (pu.indexOf('/api/social/') !== -1) {
                      var dm = pu.match(/^(https?:\/\/[^/]+)/);
                      if (dm) { profileDomains.push(dm[1]); break; }
                    }
                  }
                } catch (_) {}
              }

              var pCommonQs = '';
              try {
                if (_httpModule && typeof _httpModule._getCommonParams === 'function') {
                  pCommonQs = _httpModule._getCommonParams();
                }
              } catch (_) {}
              if (!pCommonQs) pCommonQs = 'zpw_ver=645&zpw_type=30';

              if (profileDomains.length) {
                var profileUrl = profileDomains[0] + '/api/social/group/members?' + pCommonQs + '&params=' + encodeURIComponent(encProfileParams);
                console.log('[ZaloMain] raw HTTP getGroupMembersInfo to:', profileUrl.substring(0, 80) + '...');

                var profileResp = await withTimeout(
                  fetch(profileUrl, { credentials: 'include' }).then(function (r) { return r.json(); }),
                  15000, null
                );

                if (profileResp && profileResp.error_code === 0 && profileResp.data) {
                  if (_encoderModule) {
                    var decFn2 = _encoderModule.decodeAES; // Use hooked version
                    var decStr2 = typeof decFn2 === 'function' ? decFn2(profileResp.data, 0) : null;
                    if (decStr2) {
                      var decJson2 = JSON.parse(decStr2);
                      if (decJson2.data && decJson2.data.profiles) {
                        console.log('[ZaloMain] raw HTTP getGroupMembersInfo got', Object.keys(decJson2.data.profiles).length, 'profiles');
                        indexProfileByKey(groupProfileMap, decJson2.data.profiles);
                      } else if (decJson2.profiles) {
                        console.log('[ZaloMain] raw HTTP getGroupMembersInfo got', Object.keys(decJson2.profiles).length, 'profiles');
                        indexProfileByKey(groupProfileMap, decJson2.profiles);
                      }
                    }
                  } else {
                    console.warn('[ZaloMain] raw HTTP profile: encoder module not available for decrypt');
                  }
                }
              }
            }
          } catch (e) {
            console.warn('[ZaloMain] raw HTTP getGroupMembersInfo failed:', e.message);
          }
        }
      }

      console.log('[ZaloMain] enrichment results — groupProfileMap:', Object.keys(groupProfileMap).length,
        'userInfoMap:', Object.keys(userInfoMap).length,
        'friendProfileMap matches:', memberVersionKeys.filter(function (k) {
          var plain = k.replace(/_\d+$/, '');
          return !!friendProfileMap[plain];
        }).length);

      membersByGroup[groupId] = memberVersionKeys.map(function (memberKey, index) {
        var plainKey = String(memberKey || '').replace(/_\d+$/, '');
        var friendProfile = friendProfileMap[plainKey] || friendProfileMap[memberKey] || null;
        var uiProfile = userInfoMap[memberKey] || userInfoMap[plainKey] || {};
        var gmProfile = groupProfileMap[memberKey] || groupProfileMap[plainKey] || {};
        var currentMem = currentMemsMap[plainKey] || currentMemsMap[memberKey] || {};
        var actualUserId = String(
          friendProfile && friendProfile.userId
          || uiProfile.userId || uiProfile.id
          || gmProfile.userId || gmProfile.id
          || plainKey
        ).trim();

        if (!actualUserId || actualUserId === accountUserId) return null;

        // Name resolution: friend list → getUserInfo → getGroupMembersInfo → currentMems.dName
        var displayName = '';
        if (friendProfile) {
          displayName = friendProfile.displayName || friendProfile.zaloName || '';
        }
        if (!displayName) {
          displayName = uiProfile.displayName || uiProfile.zaloName || '';
        }
        if (!displayName) {
          displayName = gmProfile.displayName || gmProfile.zaloName || '';
        }
        if (!displayName && currentMem) {
          displayName = currentMem.dName || currentMem.displayName || currentMem.zaloName || currentMem.name || '';
        }

        var avatar = '';
        if (friendProfile) avatar = friendProfile.avatar || '';
        if (!avatar) avatar = uiProfile.avatar || gmProfile.avatar || '';
        if (!avatar && currentMem) avatar = currentMem.avatar || currentMem.avatar_25 || '';

        var role = 'Thành viên';
        if (creatorId && creatorId === actualUserId) {
          role = 'Trưởng nhóm';
        } else if (adminIdSet.has(actualUserId) || Number(gmProfile.isAdmin) === 1 || Number(gmProfile.is_admin) === 1) {
          role = 'Phó nhóm';
        }

        var isFriend = Boolean(friendProfile)
          || Number(uiProfile.isFr) === 1
          || existingFriendIds.has(actualUserId)
          || existingFriendIds.has(String(uiProfile.username || '').trim())
          || existingFriendIds.has(String(uiProfile.globalId || '').trim());

        return {
          key: groupId + '_' + actualUserId,
          zid: actualUserId,
          name: displayName || 'Thành viên',
          avatar: avatar,
          phone: '—',
          role: role,
          relationLabel: isFriend ? 'Bạn bè' : 'Chưa kết bạn',
          isFriend: isFriend,
          sourceTab: group.name || group.displayName || 'Nhóm',
          groupId: groupId,
          rowKey: String(actualUserId || index),
        };
      }).filter(Boolean);

      console.log('[ZaloMain] group', groupId, 'resolved:', membersByGroup[groupId].length, 'members,',
        membersByGroup[groupId].filter(function (m) { return m.name !== 'Thành viên'; }).length, 'with names,',
        'names:', membersByGroup[groupId].map(function (m) { return m.name; }).join(', '));
    }

    return { membersByGroup: membersByGroup };
  }

  function executeApiCall(method, args) {
    if (!initWebpackApi()) {
      return Promise.reject(new Error('Webpack API chưa sẵn sàng. Trang Zalo có thể chưa tải xong.'));
    }

    switch (method) {
      case 'sendZText': {
        var isGroup = !!args.isGroup;
        var toId = normalizeConversationId(args.toId, isGroup);
        var message = args.message;
        var clientId = args.clientId || generateClientId();
        var sendText = getSendTextFunction();
        if (!sendText) {
          return Promise.reject(new Error('Không tìm thấy hàm gửi text của Zalo runtime.'));
        }
        console.log('[ZaloMain] Sending text via', sendText.source, 'module');
        return sendText.fn(toId, message, isGroup, clientId, 0, null, null);
      }

      case 'sendSticker': {
        return _httpModule.sendSticker(
          args.toId, args.stickerId, args.cateId, args.type || 0,
          !!args.isGroup, args.clientId || generateClientId(), 0, null, null
        );
      }

      case 'sendFriendRequest': {
        var dThN = null;
        try { dThN = _wr('dThN'); } catch (e) {}
        if (dThN && dThN.default && typeof dThN.default.sendFriendRequest === 'function') {
          return dThN.default.sendFriendRequest(args.userId, args.message || '');
        }
        // Fallback: use fBUP if available
        if (typeof _httpModule.sendFriendRequest === 'function') {
          return _httpModule.sendFriendRequest(args.userId, args.message || '');
        }
        return Promise.reject(new Error('sendFriendRequest không khả dụng.'));
      }

      case 'keepAlive': {
        var keepAliveOwner = _businessModule || _httpModule;
        if (!keepAliveOwner || typeof keepAliveOwner.keepAlive !== 'function') {
          return Promise.reject(new Error('keepAlive không khả dụng.'));
        }
        return keepAliveOwner.keepAlive();
      }

      case 'checkApiReady': {
        return Promise.resolve({
          ready: _apiReady,
          hasHttpModule: !!_httpModule,
          hasBusinessModule: !!_businessModule,
          sendStrategy: getSendTextFunction() ? getSendTextFunction().source : null,
        });
      }

      case 'getSessionSnapshot': {
        return Promise.resolve(buildSessionSnapshot());
      }

      case 'getConversationPreview': {
        return getConversationPreview(args.toId);
      }

      case 'resolveGroupMembers': {
        return resolveGroupMembers(args || {});
      }

      case 'resolveUserTargets': {
        return resolveUserTargets(args || {});
      }

      case 'getConversationList': {
        return getConversationList();
      }

      case 'getMessageHistory': {
        return getMessageHistory(args.threadId, !!args.isGroup, args.count || 20);
      }

      case 'debugGetMessageHistory': {
        // Full diagnostic for message history — returns detailed info about what's happening
        var diagThreadId = args.threadId || '';
        var diagIsGroup = !!args.isGroup;
        var diagCount = args.count || 5;
        var diag = {
          threadId: diagThreadId,
          isGroup: diagIsGroup,
          apiReady: _apiReady,
          hasHttpModule: !!_httpModule,
          hasBusinessModule: !!_businessModule,
          hasEncoderModule: !!_encoderModule,
          httpModuleMethods: [],
          businessModuleMethods: [],
          zStorageMethods: [],
          getCMAvailable: false,
          getHistoryMessageAvailable: false,
          syncCloudMsgAvailable: false,
          getCloudMessageJumpAvailable: false,
          getCMResult: null,
          getCMError: null,
          extractedCount: 0,
        };
        
        var diagMods = [
          { name: 'httpModule', mod: _httpModule },
          { name: 'businessModule', mod: _businessModule },
        ];
        for (var dmi = 0; dmi < diagMods.length; dmi++) {
          var dm = diagMods[dmi];
          if (!dm.mod) continue;
          var methods = Object.keys(dm.mod).filter(function (k) {
            return typeof dm.mod[k] === 'function';
          }).sort();
          diag[dm.name + 'Methods'] = methods;
        }
        
        var diagZs = window.$$afmc && window.$$afmc.zStorage;
        if (diagZs) {
          diag.zStorageMethods = Object.keys(diagZs).filter(function (k) {
            return typeof diagZs[k] === 'function';
          }).sort();
        }

        var diagHttpMod = _httpModule || _businessModule;
        if (diagHttpMod) {
          diag.getCMAvailable = typeof diagHttpMod.getCM === 'function';
          diag.getHistoryMessageAvailable = typeof diagHttpMod.getHistoryMessage === 'function';
          diag.syncCloudMsgAvailable = typeof diagHttpMod.syncCloudMsgFirstLogin === 'function';
          diag.getCloudMessageJumpAvailable = typeof diagHttpMod.getCloudMessageJump === 'function';
          
          if (diagThreadId && diag.getCMAvailable) {
            // Wrap in async IIFE since executeApiCall is not async
            return (async function () {
              try {
                var diagReqId = Date.now();
                var diagCM = await withTimeout(diagHttpMod.getCM(diagThreadId, 0, 0, diagCount, diagReqId, 10000, {}), 15000, null);
                if (diagCM) {
                  diag.getCMResult = {
                    type: typeof diagCM,
                    keys: Object.keys(diagCM),
                    preview: JSON.stringify(diagCM).slice(0, 1500),
                    dataType: diagCM.data ? typeof diagCM.data : 'none',
                    dataKeys: diagCM.data && typeof diagCM.data === 'object' ? Object.keys(diagCM.data) : [],
                    dataStringLength: typeof diagCM.data === 'string' ? diagCM.data.length : 0,
                    errorCode: diagCM.error_code,
                    errorMessage: diagCM.error_message,
                  };
                  var diagMsgs = extractMessages(diagCM);
                  diag.extractedCount = diagMsgs.length;
                  if (diagMsgs.length > 0) {
                    diag.firstMessageKeys = Object.keys(diagMsgs[0]);
                    diag.firstMessagePreview = JSON.stringify(diagMsgs[0]).slice(0, 500);
                  }
                } else {
                  diag.getCMResult = 'null (timeout or empty)';
                }
              } catch (e) {
                diag.getCMError = e.message;
              }
              console.log('[ZaloMain] debugGetMessageHistory:', JSON.stringify(diag, null, 2));
              return diag;
            })();
          }
        }
        
        console.log('[ZaloMain] debugGetMessageHistory:', JSON.stringify(diag, null, 2));
        return Promise.resolve(diag);
      }

      case 'debugModuleMethods': {
        var debugInfo = { httpModule: [], businessModule: [], zStorage: [] };
        if (_httpModule) {
          debugInfo.httpModule = Object.keys(_httpModule).filter(function (k) {
            return typeof _httpModule[k] === 'function';
          }).sort();
        }
        if (_businessModule) {
          debugInfo.businessModule = Object.keys(_businessModule).filter(function (k) {
            return typeof _businessModule[k] === 'function';
          }).sort();
        }
        var zs = window.$$afmc && window.$$afmc.zStorage;
        if (zs) {
          debugInfo.zStorage = Object.keys(zs).filter(function (k) {
            return typeof zs[k] === 'function';
          }).sort();
        }
        return Promise.resolve(debugInfo);
      }

      // ─── Account management actions ───

      case 'removeFriend': {
        return callFirstAvailableMethod(['removeFriend'], [args.userId]);
      }

      case 'leaveGroup': {
        var lgId = normalizeConversationId(args.groupId || args.userId, true);
        return callFirstAvailableMethod(['leaveGroup'], [lgId]);
      }

      case 'undoFriendRequest': {
        return callFirstAvailableMethod(['undoFriendRequest'], [args.userId]);
      }

      case 'acceptFriendRequest': {
        return callFirstAvailableMethod(['acceptFriendRequest'], [args.userId]);
      }

      case 'rejectFriendRequest': {
        return callFirstAvailableMethod(['rejectFriendRequest'], [args.userId]);
      }

      case 'addUserToGroup': {
        var pullUserId = String(args.userId || '').trim();
        var pullGroupId = normalizeConversationId(args.targetGroupId, true);
        return callFirstAvailableMethod(['addUserToGroup'], [pullUserId, pullGroupId]);
      }

      case 'joinGroupLink': {
        var link = String(args.inviteLink || args.link || '').trim();
        if (!link) return Promise.reject(new Error('Không tìm thấy link mời nhóm.'));
        return callFirstAvailableMethod(['joinGroupLink'], [link]);
      }

      case 'setMute': {
        // args: { action: 'mute'|'unmute', threadId, isGroup }
        var muteIsGroup = !!args.isGroup;
        var muteThreadId = normalizeConversationId(args.threadId || args.userId, muteIsGroup);
        var muteAction = args.action === 'unmute' ? 0 : 1; // 0=unmute, 1=mute
        var muteDuration = args.action === 'unmute' ? 0 : -1; // -1=forever
        return callFirstAvailableMethod(['setMute'], [{ action: muteAction, duration: muteDuration }, muteThreadId, muteIsGroup ? 1 : 0]);
      }

      case 'findUser': {
        var phone = String(args.phone || '').trim();
        if (!phone) return Promise.reject(new Error('Thiếu số điện thoại để tra cứu.'));
        return callFirstAvailableMethod(['findUser'], [phone]);
      }

      case 'getAllFriends': {
        var zStorage = window.$$afmc && window.$$afmc.zStorage;
        if (zStorage && typeof zStorage.getFriends === 'function') {
          return zStorage.getFriends();
        }
        return callFirstAvailableMethod(['getAllFriends'], []);
      }

      case 'getAllGroups': {
        var zStorage2 = window.$$afmc && window.$$afmc.zStorage;
        if (zStorage2 && typeof zStorage2.getGroups === 'function') {
          return zStorage2.getGroups();
        }
        return callFirstAvailableMethod(['getAllGroups'], []);
      }

      case 'fetchAccountInfo': {
        return callFirstAvailableMethod(['fetchAccountInfo'], []);
      }

      case 'getSentFriendRequest': {
        return callFirstAvailableMethod(['getSentFriendRequest'], []);
      }

      case 'getReceivedFriendRequests': {
        return callFirstAvailableMethod(['getReceivedFriendRequests'], []);
      }

      case 'getGroupInfo': {
        var gIds = Array.isArray(args.groupIds) ? args.groupIds : [args.groupId];
        return callFirstAvailableMethod(['getGroupInfo', 'getGroupInfos'], [gIds]);
      }

      case 'runActionBatch': {
        return runActionBatch(args);
      }

      default:
        return Promise.reject(new Error('Phương thức API không xác định: ' + method));
    }
  }

  async function runActionBatch(args) {
    var jobs = Array.isArray(args.jobs) ? args.jobs : [];
    if (!jobs.length) return { ok: false, error: 'Danh sách thao tác rỗng.' };

    var results = [];

    for (var i = 0; i < jobs.length; i++) {
      var job = jobs[i];
      var actionType = String(job.actionType || '').trim();
      var zid = String(job.zid || '').trim();
      var isGroup = /^g/.test(zid) || !!job.isGroup;
      var startedAt = new Date().toISOString();

      if (!zid || zid === '—') {
        results.push({ jobId: job.id, ok: false, status: 'failed', statusLabel: 'Thiếu Zalo ID', error: 'Không tìm thấy ID hợp lệ.', startedAt: startedAt, failedAt: new Date().toISOString(), provider: 'extension' });
        continue;
      }

      try {
        var apiResult = null;
        if (actionType === 'remove_friend') {
          apiResult = await executeApiCall('removeFriend', { userId: zid });
          results.push({ jobId: job.id, ok: true, status: 'completed', statusLabel: 'Đã xóa bạn', startedAt: startedAt, sentAt: new Date().toISOString(), provider: 'extension', apiResult: apiResult });
        } else if (actionType === 'leave_group') {
          apiResult = await executeApiCall('leaveGroup', { groupId: zid });
          var memberErrors = Array.isArray(apiResult && apiResult.memberError) ? apiResult.memberError : [];
          if (memberErrors.indexOf(zid) !== -1) throw new Error('Zalo từ chối thao tác rời nhóm.');
          results.push({ jobId: job.id, ok: true, status: 'completed', statusLabel: 'Đã rời nhóm', startedAt: startedAt, sentAt: new Date().toISOString(), provider: 'extension', apiResult: apiResult });
        } else if (actionType === 'undo_friend_request') {
          apiResult = await executeApiCall('undoFriendRequest', { userId: zid });
          results.push({ jobId: job.id, ok: true, status: 'completed', statusLabel: 'Đã thu hồi lời mời', startedAt: startedAt, sentAt: new Date().toISOString(), provider: 'extension', apiResult: apiResult });
        } else if (actionType === 'accept_friend_request') {
          apiResult = await executeApiCall('acceptFriendRequest', { userId: zid });
          results.push({ jobId: job.id, ok: true, status: 'completed', statusLabel: 'Đã chấp nhận lời mời', startedAt: startedAt, sentAt: new Date().toISOString(), provider: 'extension', apiResult: apiResult });
        } else if (actionType === 'reject_friend_request') {
          apiResult = await executeApiCall('rejectFriendRequest', { userId: zid });
          results.push({ jobId: job.id, ok: true, status: 'completed', statusLabel: 'Đã từ chối lời mời', startedAt: startedAt, sentAt: new Date().toISOString(), provider: 'extension', apiResult: apiResult });
        } else if (actionType === 'pull_group') {
          var targetGroupId = String(job.targetGroupId || '').trim();
          if (!targetGroupId) throw new Error('Chưa chọn nhóm đích.');
          apiResult = await executeApiCall('addUserToGroup', { userId: zid, targetGroupId: targetGroupId });
          var errorMembers = Array.isArray(apiResult && apiResult.errorMembers) ? apiResult.errorMembers : [];
          if (errorMembers.indexOf(zid) !== -1) {
            var errMsg = (apiResult.error_data && apiResult.error_data[zid] && apiResult.error_data[zid][0]) || 'Không thể mời vào nhóm.';
            throw new Error(errMsg);
          }
          results.push({ jobId: job.id, ok: true, status: 'completed', statusLabel: 'Đã mời vào ' + (job.targetGroupName || 'nhóm'), startedAt: startedAt, sentAt: new Date().toISOString(), provider: 'extension', apiResult: apiResult });
        } else if (actionType === 'join_group') {
          try {
            apiResult = await executeApiCall('joinGroupLink', { inviteLink: job.inviteLink || job.link });
            results.push({ jobId: job.id, ok: true, status: 'completed', statusLabel: 'Đã tham gia nhóm', startedAt: startedAt, sentAt: new Date().toISOString(), provider: 'extension', apiResult: apiResult });
          } catch (joinErr) {
            var joinCode = typeof joinErr.code === 'number' ? joinErr.code : null;
            if (joinCode === 178) {
              results.push({ jobId: job.id, ok: true, status: 'skipped', statusLabel: 'Đã ở trong nhóm', startedAt: startedAt, sentAt: new Date().toISOString(), provider: 'extension' });
            } else if (joinCode === 240) {
              results.push({ jobId: job.id, ok: true, status: 'pending', statusLabel: 'Đã gửi yêu cầu vào nhóm', startedAt: startedAt, sentAt: new Date().toISOString(), provider: 'extension' });
            } else {
              throw joinErr;
            }
          }
        } else if (actionType === 'mute') {
          apiResult = await executeApiCall('setMute', { action: 'mute', threadId: zid, isGroup: isGroup });
          results.push({ jobId: job.id, ok: true, status: 'completed', statusLabel: 'Đã tắt thông báo', startedAt: startedAt, sentAt: new Date().toISOString(), provider: 'extension', apiResult: apiResult });
        } else if (actionType === 'unmute') {
          apiResult = await executeApiCall('setMute', { action: 'unmute', threadId: zid, isGroup: isGroup });
          results.push({ jobId: job.id, ok: true, status: 'completed', statusLabel: 'Đã bật thông báo', startedAt: startedAt, sentAt: new Date().toISOString(), provider: 'extension', apiResult: apiResult });
        } else {
          throw new Error('Action không được hỗ trợ: ' + actionType);
        }
      } catch (err) {
        results.push({ jobId: job.id, ok: false, status: 'failed', statusLabel: actionType === 'remove_friend' ? 'Xóa bạn thất bại' : actionType === 'leave_group' ? 'Rời nhóm thất bại' : actionType === 'undo_friend_request' ? 'Thu hồi thất bại' : actionType === 'accept_friend_request' ? 'Chấp nhận thất bại' : actionType === 'reject_friend_request' ? 'Từ chối thất bại' : actionType === 'pull_group' ? 'Kéo nhóm thất bại' : actionType === 'join_group' ? 'Tham gia thất bại' : actionType === 'mute' ? 'Tắt TB thất bại' : actionType === 'unmute' ? 'Bật TB thất bại' : 'Thao tác thất bại', error: err.message || String(err), startedAt: startedAt, failedAt: new Date().toISOString(), provider: 'extension' });
      }

      // Delay between jobs
      if (i < jobs.length - 1 && job.delayWindow) {
        var dw = String(job.delayWindow).split('-').map(Number);
        var minDel = dw[0] || 1000;
        var maxDel = dw[1] || minDel;
        var waitMs = minDel + Math.floor(Math.random() * (maxDel - minDel));
        if (waitMs > 0) await new Promise(function (r) { setTimeout(r, waitMs); });
      }
    }

    return {
      ok: true,
      provider: 'extension',
      accepted: results.filter(function (r) { return r.ok; }).length,
      failed: results.filter(function (r) { return !r.ok; }).length,
      results: results,
    };
  }

  // Listen for API calls from ISOLATED world (zalo-bridge.js)
  // Uses window.postMessage because CustomEvent.detail does NOT cross
  // from ISOLATED → MAIN world in Chrome extensions.
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.source !== '__zalotool_api__') return;

    // Handle init request
    if (e.data.action === 'init') {
      tryInitApi();
      return;
    }

    var callId = e.data.callId;

    executeApiCall(e.data.method, e.data.args || {})
      .then(function (data) {
        window.dispatchEvent(new CustomEvent('__zalotool_api_result__', {
          detail: JSON.stringify({ callId: callId, ok: true, data: data }),
        }));
      })
      .catch(function (err) {
        window.dispatchEvent(new CustomEvent('__zalotool_api_result__', {
          detail: JSON.stringify({ callId: callId, ok: false, error: err.message || String(err) }),
        }));
      });
  });

  // Initialize API bridge AFTER extraction completes (to avoid
  // interfering with Zalo's webpack runtime during page load).
  var _extractionDone = false;

  function tryInitApi() {
    if (_apiReady) return;
    if (!window.webpackJsonp) return;
    if (initWebpackApi()) {
      console.log('[ZaloMain] Webpack API bridge ready');
      dispatch('session', buildSessionSnapshot());
      dispatch('api_ready', { available: true });
    }
  }

  // ============================================================

  // Listen for manual re-extract requests
  window.addEventListener('__zalotool_extract__', function () {
    extractAll();
  });

  // Poll until zStorage is ready
  var timer = setInterval(function () {
    attempt++;
    if (attempt > MAX_WAIT) {
      clearInterval(timer);
      console.log('[ZaloMain] Gave up waiting for $$afmc.zStorage');
      return;
    }
    if (window.$$afmc && window.$$afmc.zStorage) {
      clearInterval(timer);
      // Small delay for zStorage to finish initialising.
      setTimeout(function () { extractAll(); }, INITIAL_EXTRACT_DELAY);
    }
  }, 1000);

  console.log('[ZaloMain] Waiting for $$afmc.zStorage…');
})();
