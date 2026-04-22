/* ISOLATED world on chat.zalo.me
   Collects data from zalo-main.js (MAIN world) via CustomEvents,
   then forwards everything to the background service worker.
   Uses direct Zalo API calls (via webpack bridge) for message sending,
   with DOM automation as fallback. */

(function () {
  'use strict';

  var collected = { me: null, friends: null, groups: null, session: null };
  var sent = false;
  var messageBatchRunning = false;
  var apiAvailable = false; // Set true when zalo-main.js reports API is ready

  function runtimeSendMessage(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: true });
        });
      } catch (error) {
        resolve({ ok: false, error: error.message });
      }
    });
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function normalizeText(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getElementText(element) {
    if (!element) return '';
    return (element.innerText || element.textContent || '').trim();
  }

  function isVisibleElement(element) {
    if (!element || !element.isConnected) return false;
    var rect = element.getBoundingClientRect();
    var style = window.getComputedStyle(element);
    return !!(
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      style.opacity !== '0'
    );
  }

  function setInputValue(element, value) {
    var prototype = Object.getPrototypeOf(element);
    var descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value') : null;
    if (descriptor && typeof descriptor.set === 'function') {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setEditableValue(element, value) {
    element.focus();
    try {
      var selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        var range = document.createRange();
        range.selectNodeContents(element);
        selection.addRange(range);
      }
      if (document.execCommand) {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, value);
      } else {
        element.textContent = value;
      }
    } catch (_) {
      element.textContent = value;
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
  }

  function getMessageDelay(delayWindow) {
    var match = String(delayWindow || '').match(/(\d+)\s*-\s*(\d+)/);
    if (!match) return 1200;
    var from = Number(match[1]);
    var to = Number(match[2]);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return 1200;
    var min = Math.min(from, to);
    var max = Math.max(from, to);
    return (min + Math.floor(Math.random() * (max - min + 1))) * 1000;
  }

  // === Webpack API Bridge (communicates with zalo-main.js MAIN world) ===

  var API_CALL_TIMEOUT = 15000;

  function callZaloApi(method, args) {
    return new Promise(function (resolve, reject) {
      var callId = 'api_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
      var timeoutId = null;

      function handler(e) {
        var result;
        try { result = JSON.parse(e.detail); } catch (_) { return; }
        if (result.callId !== callId) return;

        cleanup();
        if (result.ok) {
          resolve(result.data);
        } else {
          reject(new Error(result.error || 'API call failed'));
        }
      }

      function cleanup() {
        if (timeoutId) clearTimeout(timeoutId);
        window.removeEventListener('__zalotool_api_result__', handler);
      }

      window.addEventListener('__zalotool_api_result__', handler);

      timeoutId = setTimeout(function () {
        cleanup();
        reject(new Error('API call timed out after ' + API_CALL_TIMEOUT + 'ms'));
      }, API_CALL_TIMEOUT);

      // Use postMessage (not CustomEvent) because CustomEvent.detail
      // does NOT cross from ISOLATED → MAIN world in Chrome extensions.
      window.postMessage({
        source: '__zalotool_api__',
        callId: callId,
        method: method,
        args: args,
      }, '*');
    });
  }

  function isGroupJob(job) {
    if (job.isGroup === true) return true;
    var tab = String(job.sourceTab || '').toLowerCase();
    return tab.indexOf('nhóm') !== -1 || tab.indexOf('nhom') !== -1 || tab === 'group' || tab === 'groups';
  }

  async function executeMessageViaApi(job) {
    var toId = job.zid;
    if (!toId || toId === '—') {
      throw new Error('Không có Zalo ID để gửi tin nhắn qua API.');
    }

    var content = String(job.content || '').trim();
    if (!content) {
      throw new Error('Tin nhắn không có nội dung để gửi.');
    }

    var isGroup = isGroupJob(job);
    var result = await callZaloApi('sendZText', {
      toId: toId,
      message: content,
      isGroup: isGroup,
    });

    // Check response for errors
    if (result && result.error_code && result.error_code !== 0) {
      throw new Error('Zalo API lỗi ' + result.error_code + ': ' + (result.error_message || 'Unknown'));
    }

    return result;
  }

  async function verifyMessageSent(job, beforePreview, fallbackErrorPrefix) {
    if (!job || !job.zid || job.zid === '—') {
      return { ok: true, preview: null };
    }

    var verified = await verifyMessageDelivery(job, beforePreview);
    if (verified.ok) {
      return verified;
    }

    throw new Error((fallbackErrorPrefix || 'Zalo không xác nhận việc gửi tin nhắn.') + ' Preview hội thoại không thay đổi.');
  }

  async function getConversationPreviewViaApi(toId) {
    if (!toId || toId === '—') return null;
    try {
      return await callZaloApi('getConversationPreview', { toId: toId });
    } catch (_) {
      return null;
    }
  }

  function didConversationAdvance(beforePreview, afterPreview, content) {
    var expected = String(content || '').trim();
    var previewSnippet = expected.slice(0, 40);
    if (!afterPreview) return false;
    if (!beforePreview) {
      return previewSnippet
        ? String(afterPreview.lastMsg || '').indexOf(previewSnippet) !== -1
        : false;
    }

    if (previewSnippet && String(afterPreview.lastMsg || '').indexOf(previewSnippet) !== -1) {
      return true;
    }

    var beforeTime = Number(beforePreview.lastMsgTime || 0);
    var afterTime = Number(afterPreview.lastMsgTime || 0);
    return afterTime > beforeTime;
  }

  async function verifyMessageDelivery(job, beforePreview) {
    for (var attempt = 0; attempt < 6; attempt += 1) {
      await sleep(900 + (attempt * 400));
      var afterPreview = await getConversationPreviewViaApi(job.zid);
      if (didConversationAdvance(beforePreview, afterPreview, job.content)) {
        return { ok: true, preview: afterPreview };
      }
    }

    return { ok: false };
  }

  async function ensureApiReady() {
    if (apiAvailable) return true;

    window.postMessage({ source: '__zalotool_api__', action: 'init' }, '*');
    await sleep(1000);

    var probe = await callZaloApi('checkApiReady', {});
    apiAvailable = !!(probe && probe.ready);
    return apiAvailable;
  }

  function pushCollectedDataToBackground() {
    console.log('[ZaloBridge] Syncing collected Zalo data to background');
    chrome.runtime.sendMessage({
      type: 'ZALO_DATA_READY',
      data: {
        me: collected.me,
        friends: collected.friends || [],
        groups: collected.groups || [],
        session: collected.session || null,
      },
    }, function (resp) {
      if (chrome.runtime.lastError) {
        console.error('[ZaloBridge]', chrome.runtime.lastError.message);
      } else {
        console.log('[ZaloBridge] Background acknowledged:', resp);
      }
    });
  }

  // ===

  function clearSearchInput(input) {
    if (!input) return;
    input.focus();
    if (typeof input.value === 'string') {
      setInputValue(input, '');
    } else if (input.isContentEditable) {
      setEditableValue(input, '');
    }
  }

  function fillSearchInput(input, query) {
    input.focus();
    if (typeof input.value === 'string') {
      setInputValue(input, query);
    } else if (input.isContentEditable) {
      setEditableValue(input, query);
    }
  }

  function getClickableAncestor(element) {
    var current = element;
    while (current && current !== document.body) {
      if (
        current.matches && current.matches('button, a, [role="button"], [tabindex], li, [data-id]')
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return element;
  }

  function findSearchInput() {
    var selectors = [
      'input[placeholder*="Tìm"]',
      'input[placeholder*="tim"]',
      'input[placeholder*="Search"]',
      'input[aria-label*="Tìm"]',
      'input[aria-label*="Search"]',
      'input[type="search"]',
      'input[type="text"]',
      '[contenteditable="true"]',
    ];

    var candidates = [];
    selectors.forEach(function (selector) {
      candidates = candidates.concat(Array.from(document.querySelectorAll(selector)));
    });

    return candidates
      .filter(isVisibleElement)
      .sort(function (left, right) {
        var leftRect = left.getBoundingClientRect();
        var rightRect = right.getBoundingClientRect();
        return (leftRect.top + leftRect.left) - (rightRect.top + rightRect.left);
      })
      .find(function (element) {
        var rect = element.getBoundingClientRect();
        return rect.top < window.innerHeight * 0.4 && rect.left < window.innerWidth * 0.5;
      }) || null;
  }

  function findConversationCandidate(searchInput, targets) {
    var searchRect = searchInput ? searchInput.getBoundingClientRect() : null;
    var matchingTargets = targets.filter(Boolean).map(normalizeText);
    var candidates = Array.from(document.querySelectorAll('button, a, [role="button"], li, div, span'))
      .filter(isVisibleElement)
      .map(getClickableAncestor)
      .filter(function (element, index, all) {
        return all.indexOf(element) === index;
      })
      .filter(function (element) {
        var rect = element.getBoundingClientRect();
        if (searchRect && rect.top < searchRect.bottom - 4) return false;
        if (rect.left > window.innerWidth * 0.6) return false;
        if (rect.width > window.innerWidth * 0.7 || rect.height > 220) return false;
        var text = normalizeText(getElementText(element));
        if (!text) return false;
        return matchingTargets.some(function (target) {
          return target && text.indexOf(target) !== -1;
        });
      })
      .sort(function (left, right) {
        var leftRect = left.getBoundingClientRect();
        var rightRect = right.getBoundingClientRect();
        return leftRect.top - rightRect.top;
      });

    return candidates[0] || null;
  }

  function findComposer(searchInput) {
    var candidates = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]'))
      .filter(isVisibleElement)
      .filter(function (element) {
        if (element === searchInput) return false;
        if (searchInput && (element.contains(searchInput) || searchInput.contains(element))) return false;
        var rect = element.getBoundingClientRect();
        return rect.bottom > window.innerHeight * 0.5 && rect.height >= 24;
      })
      .sort(function (left, right) {
        return right.getBoundingClientRect().top - left.getBoundingClientRect().top;
      });

    return candidates[0] || null;
  }

  function findSendButton(composer) {
    if (!composer) return null;
    var composerRect = composer.getBoundingClientRect();
    var scopes = [composer.closest('form, footer, section, div'), document.body].filter(Boolean);

    for (var scopeIndex = 0; scopeIndex < scopes.length; scopeIndex += 1) {
      var scope = scopes[scopeIndex];

      var textMatched = Array.from(scope.querySelectorAll('button, [role="button"]'))
        .filter(isVisibleElement)
        .find(function (element) {
          var text = normalizeText((element.getAttribute('aria-label') || '') + ' ' + getElementText(element));
          return text.indexOf('gui') !== -1 || text.indexOf('send') !== -1;
        });

      if (textMatched) return textMatched;

      var nearbyButtons = Array.from(scope.querySelectorAll('button, [role="button"]'))
        .filter(isVisibleElement)
        .filter(function (element) {
          var rect = element.getBoundingClientRect();
          return rect.top >= composerRect.top - 40 && rect.bottom <= window.innerHeight + 20 && rect.left >= composerRect.left;
        })
        .sort(function (left, right) {
          var leftRect = left.getBoundingClientRect();
          var rightRect = right.getBoundingClientRect();
          return (rightRect.left - leftRect.left) || (rightRect.top - leftRect.top);
        });

      if (nearbyButtons[0]) return nearbyButtons[0];
    }

    return null;
  }

  function readComposerText(composer) {
    if (!composer) return '';
    if (typeof composer.value === 'string') return composer.value.trim();
    return getElementText(composer);
  }

  async function clickConversationCandidate(candidate) {
    if (!candidate) return false;
    candidate.click();
    await sleep(1500);
    return true;
  }

  async function openConversation(job) {
    var queries = [job.phone, job.name, job.zid]
      .filter(Boolean)
      .filter(function (value) { return value !== '—'; });
    var targets = [job.name, job.phone, job.zid].filter(Boolean);

    if (!queries.length) {
      throw new Error('Thiếu dữ liệu để tìm hội thoại trên Zalo.');
    }

    var searchInput = findSearchInput();
    var directCandidate = findConversationCandidate(null, targets.concat(queries));
    if (await clickConversationCandidate(directCandidate)) {
      return;
    }

    if (!searchInput) {
      throw new Error('Không tìm thấy ô tìm kiếm hoặc hội thoại khớp trên Zalo Web.');
    }

    for (var index = 0; index < queries.length; index += 1) {
      clearSearchInput(searchInput);
      await sleep(150);
      fillSearchInput(searchInput, queries[index]);
      await sleep(900);

      var candidate = findConversationCandidate(searchInput, targets.concat([queries[index]]));
      if (await clickConversationCandidate(candidate)) {
        return;
      }
    }

    throw new Error('Không tìm thấy hội thoại khớp với dữ liệu đã chọn.');
  }

  function isPlaceholderMessageText(value) {
    var normalized = normalizeText(value);
    return !normalized || normalized === normalizeText('[Tin nhắn không có nội dung]');
  }

  function stripMessageMetaLines(value) {
    return String(value || '')
      .split(/\n+/)
      .map(function (line) { return line.trim(); })
      .filter(function (line) {
        if (!line) return false;
        if (/^\d{1,2}:\d{2}(\s?(am|pm))?$/i.test(line)) return false;
        var normalized = normalizeText(line);
        return ['da xem', 'seen', 'hom nay', 'today', 'hom qua', 'yesterday'].indexOf(normalized) === -1;
      })
      .join('\n')
      .trim();
  }

  function shouldFallbackMessageHistory(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return true;
    return messages.every(function (message) {
      return isPlaceholderMessageText(message && message.content);
    });
  }

  function findMessagePane(searchInput) {
    var composer = findComposer(searchInput);
    var composerRect = composer ? composer.getBoundingClientRect() : null;

    var candidates = Array.from(document.querySelectorAll('main, section, div, [role="main"]'))
      .filter(isVisibleElement)
      .filter(function (element) {
        if (element === composer) return false;
        var rect = element.getBoundingClientRect();
        if (rect.right < window.innerWidth * 0.45) return false;
        if (rect.width < window.innerWidth * 0.22 || rect.height < window.innerHeight * 0.22) return false;
        if (composerRect && rect.bottom > composerRect.top + 24) return false;
        return element.scrollHeight > rect.height + 40 || rect.height > window.innerHeight * 0.45;
      })
      .sort(function (left, right) {
        var leftRect = left.getBoundingClientRect();
        var rightRect = right.getBoundingClientRect();
        var leftScore = (leftRect.width * leftRect.height) + Math.max(0, left.scrollHeight - left.clientHeight) * 25;
        var rightScore = (rightRect.width * rightRect.height) + Math.max(0, right.scrollHeight - right.clientHeight) * 25;
        return rightScore - leftScore;
      });

    return candidates[0] || null;
  }

  function resolveBubbleElementFromTextNode(node, pane, paneRect) {
    var current = node && node.parentElement;
    var best = null;

    while (current && current !== pane) {
      if (isVisibleElement(current)) {
        var rect = current.getBoundingClientRect();
        var text = getElementText(current);
        if (
          rect.width >= 36 &&
          rect.width <= paneRect.width * 0.95 &&
          rect.height >= 16 &&
          rect.height <= window.innerHeight * 0.45 &&
          rect.top >= paneRect.top - 4 &&
          rect.bottom <= paneRect.bottom + 4 &&
          text &&
          text.length <= 4000
        ) {
          best = current;
          if (rect.width <= paneRect.width * 0.82) {
            break;
          }
        }
      }
      current = current.parentElement;
    }

    return best;
  }

  function getBubbleText(element) {
    if (!element) return '';

    var text = stripMessageMetaLines(getElementText(element));
    if (text) return text;

    var link = Array.from(element.querySelectorAll('a[href]'))
      .map(function (anchor) {
        return (anchor.href || '').trim();
      })
      .find(Boolean);

    if (link) return '[Liên kết] ' + link;
    if (element.querySelector('video')) return '[Video]';
    if (element.querySelector('audio')) return '[Âm thanh]';
    if (element.querySelector('img, canvas, picture')) return '[Hình ảnh]';

    return '';
  }

  function buildDomMessageDescriptor(element, paneRect, threadId, index) {
    if (!element) return null;

    var text = getBubbleText(element);
    if (!text) return null;

    var rect = element.getBoundingClientRect();
    var isSelf = rect.left > paneRect.left + (paneRect.width * 0.45);
    var bubbleId = element.getAttribute('data-id') || element.getAttribute('data-msg-id') || element.id || '';
    var normalizedText = normalizeText(text).slice(0, 160);

    return {
      msgId: bubbleId ? ('dom_' + bubbleId) : ('dom_' + threadId + '_' + index + '_' + Math.round(rect.top)),
      fromId: isSelf ? '0' : String(threadId || ''),
      toId: isSelf ? String(threadId || '') : '0',
      content: text,
      ts: 0,
      msgType: text.charAt(0) === '[' ? 'attachment' : 'text',
      _sig: normalizedText + '|' + (isSelf ? '1' : '0'),
      _top: rect.top,
    };
  }

  function collectVisibleDomMessages(pane, threadId) {
    if (!pane) return [];

    var paneRect = pane.getBoundingClientRect();
    var walker = document.createTreeWalker(pane, window.NodeFilter ? window.NodeFilter.SHOW_TEXT : 4, null);
    var seen = new Set();
    var messages = [];
    var current = walker.nextNode();
    var index = 0;

    while (current) {
      var rawText = String(current.textContent || '').trim();
      if (rawText) {
        var bubble = resolveBubbleElementFromTextNode(current, pane, paneRect);
        if (bubble && !seen.has(bubble)) {
          seen.add(bubble);
          var descriptor = buildDomMessageDescriptor(bubble, paneRect, threadId, index);
          if (descriptor) {
            messages.push(descriptor);
            index += 1;
          }
        }
      }
      current = walker.nextNode();
    }

    return messages.sort(function (left, right) {
      return left._top - right._top;
    });
  }

  function mergeDomMessageSlices(olderMessages, newerMessages) {
    var newerKeys = new Set(newerMessages.map(function (message) { return message._sig; }));
    return olderMessages
      .filter(function (message) { return !newerKeys.has(message._sig); })
      .concat(newerMessages);
  }

  function finalizeDomMessages(messages, count) {
    var total = Array.isArray(messages) ? messages.length : 0;
    var trimmed = (messages || []).slice(-(Number(count) || 20));
    return trimmed.map(function (message, index) {
      return {
        msgId: message.msgId || ('dom_msg_' + index),
        fromId: message.fromId,
        toId: message.toId,
        content: message.content,
        ts: Date.now() - ((total - index) * 1000),
        msgType: message.msgType,
        status: 0,
        cliMsgId: '',
        dName: '',
        quote: null,
      };
    });
  }

  function getCurrentConversationTitle() {
    // Find the conversation header title in Zalo Web
    // It's typically in the right half of the screen, near the top
    var candidates = Array.from(document.querySelectorAll('h1, h2, h3, h4, [class*="header"] span, [class*="title"], [class*="name"], [class*="Header"] span'))
      .filter(isVisibleElement)
      .filter(function (el) {
        var rect = el.getBoundingClientRect();
        return rect.left > window.innerWidth * 0.3 &&
               rect.top < window.innerHeight * 0.2 &&
               rect.width > 60 &&
               rect.height > 10;
      })
      .sort(function (a, b) {
        // Prefer larger elements closer to top
        var aRect = a.getBoundingClientRect();
        var bRect = b.getBoundingClientRect();
        return (aRect.top - bRect.top) || (bRect.width - aRect.width);
      });
    return candidates.length > 0 ? (getElementText(candidates[0]) || '').trim() : '';
  }

  function conversationTitleMatches(currentTitle, expectedName, expectedId) {
    if (!currentTitle) return true; // can't verify, allow through
    var normalizedCurrent = normalizeText(currentTitle);
    if (expectedName && normalizeText(expectedName) && normalizedCurrent.indexOf(normalizeText(expectedName)) !== -1) return true;
    if (expectedId && normalizedCurrent.indexOf(normalizeText(String(expectedId))) !== -1) return true;
    return false;
  }

  function mergeApiHistoryWithDom(apiMessages, domMessages) {
    if (!Array.isArray(domMessages) || domMessages.length === 0) {
      return Array.isArray(apiMessages) ? apiMessages : [];
    }

    if (!Array.isArray(apiMessages) || apiMessages.length === 0) {
      return domMessages;
    }

    var merged = apiMessages.slice();
    var startIndex = Math.max(0, merged.length - domMessages.length);

    for (var index = 0; index < domMessages.length && (startIndex + index) < merged.length; index += 1) {
      if (isPlaceholderMessageText(merged[startIndex + index].content)) {
        merged[startIndex + index] = Object.assign({}, merged[startIndex + index], {
          content: domMessages[index].content,
          msgType: domMessages[index].msgType || merged[startIndex + index].msgType,
        });
      }
    }

    return merged;
  }

  async function getMessageHistoryViaDom(request) {
    var args = request && request.args ? request.args : {};
    var metaConversation = request && request.meta && request.meta.conversation ? request.meta.conversation : {};
    var threadId = args.threadId || metaConversation.id || metaConversation.rawId || '';
    var expectedName = metaConversation.displayName || metaConversation.name || '';
    var count = Number(args.count) || 20;

    await openConversation({
      zid: threadId,
      name: expectedName,
      phone: metaConversation.phone || '',
      isGroup: !!args.isGroup,
      sourceTab: args.isGroup ? 'group' : 'friend',
    });

    await sleep(1500);

    // Verify the correct conversation was opened before scraping
    var currentTitle = getCurrentConversationTitle();
    if (currentTitle && expectedName && !conversationTitleMatches(currentTitle, expectedName, threadId)) {
      console.warn('[ZaloBridge] getMessageHistoryViaDom: opened wrong conversation. Expected:', expectedName, 'Got:', currentTitle);
      throw new Error('Zalo Web đang hiển thị sai hội thoại ("' + currentTitle + '" thay vì "' + expectedName + '"). Bỏ qua DOM scraping.');
    }

    var searchInput = findSearchInput();
    var pane = findMessagePane(searchInput);
    if (!pane) {
      throw new Error('Không tìm thấy khung lịch sử tin nhắn trên Zalo Web.');
    }

    var originalScrollTop = pane.scrollTop;
    var messages = collectVisibleDomMessages(pane, threadId);
    var maxPasses = Math.max(2, Math.min(5, Math.ceil(count / 8)));

    for (var pass = 1; pass < maxPasses && messages.length < count; pass += 1) {
      var nextScrollTop = Math.max(0, pane.scrollTop - Math.max(160, pane.clientHeight * 0.8));
      if (nextScrollTop === pane.scrollTop) break;
      pane.scrollTop = nextScrollTop;
      await sleep(400);
      var olderMessages = collectVisibleDomMessages(pane, threadId);
      if (!olderMessages.length) break;
      messages = mergeDomMessageSlices(olderMessages, messages);
    }

    pane.scrollTop = originalScrollTop;
    return finalizeDomMessages(messages, count);
  }

  async function hydrateConversationForHistory(request) {
    var args = request && request.args ? request.args : {};
    var metaConversation = request && request.meta && request.meta.conversation ? request.meta.conversation : {};
    var threadId = args.threadId || metaConversation.id || metaConversation.rawId || '';

    if (!threadId) return;

    try {
      await openConversation({
        zid: threadId,
        name: metaConversation.displayName || metaConversation.name || '',
        phone: metaConversation.phone || '',
        isGroup: !!args.isGroup,
        sourceTab: args.isGroup ? 'group' : 'friend',
      });
      // Wait for Zalo to load messages from cloud into local store.
      // Poll zStorage readiness for up to 3s instead of fixed sleep.
      var maxWait = 3000;
      var interval = 300;
      var waited = 0;
      while (waited < maxWait) {
        await sleep(interval);
        waited += interval;
        try {
          var zs = window.$$afmc && window.$$afmc.zStorage;
          if (zs && typeof zs.getMessageFromConversationByLimit === 'function') {
            var probe = zs.getMessageFromConversationByLimit(threadId, 1);
            if (probe && ((Array.isArray(probe) && probe.length > 0) || (probe.then && (await probe).length > 0))) {
              console.log('[ZaloBridge] hydrateConversationForHistory: zStorage ready after', waited, 'ms');
              break;
            }
          }
        } catch (_) {}
      }
      if (waited >= maxWait) {
        console.log('[ZaloBridge] hydrateConversationForHistory: timed out waiting for zStorage, proceeding anyway');
      }
    } catch (error) {
      console.log('[ZaloBridge] hydrateConversationForHistory skipped:', error.message);
    }
  }

  async function sendThroughComposer(composer, content) {
    if (!composer) {
      throw new Error('Không tìm thấy ô soạn tin nhắn.');
    }

    composer.focus();
    if (typeof composer.value === 'string') {
      setInputValue(composer, content);
    } else {
      setEditableValue(composer, content);
    }

    await sleep(250);
    var sendButton = findSendButton(composer);
    if (sendButton) {
      sendButton.click();
    } else {
      ['keydown', 'keypress', 'keyup'].forEach(function (eventName) {
        composer.dispatchEvent(new KeyboardEvent(eventName, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
        }));
      });
    }

    await sleep(1200);
  }

  async function executeMessageJob(job) {
    if (Array.isArray(job.attachments) && job.attachments.length > 0) {
      throw new Error('Gửi file đính kèm tự động chưa được hỗ trợ.');
    }

    if (!job.content || !String(job.content).trim()) {
      throw new Error('Tin nhắn không có nội dung để gửi.');
    }

    // Try direct API call first (much faster and more reliable)
    if (apiAvailable && job.zid && job.zid !== '—') {
      try {
        var beforePreview = await getConversationPreviewViaApi(job.zid);
        await executeMessageViaApi(job);
        await verifyMessageSent(job, beforePreview, 'Zalo runtime đã trả về nhưng');
        console.log('[ZaloBridge] Message sent via runtime API to', job.zid);
        return;
      } catch (apiError) {
        console.log('[ZaloBridge] API send fallback to DOM:', apiError.message);
      }
    }

    // Fallback: DOM automation
    await executeMessageJobViaDom(job);
  }

  async function executeMessageJobViaDom(job) {
    var beforePreview = job.zid && job.zid !== '—'
      ? await getConversationPreviewViaApi(job.zid)
      : null;

    await openConversation(job);
    await sleep(800);

    var searchInput = findSearchInput();
    var composer = findComposer(searchInput);
    var previousValue = readComposerText(composer);
    await sendThroughComposer(composer, String(job.content).trim());

    if (readComposerText(composer) === String(job.content).trim() && previousValue !== String(job.content).trim()) {
      throw new Error('Zalo không xác nhận thao tác gửi tin nhắn.');
    }

    await verifyMessageSent(job, beforePreview, 'DOM đã thao tác gửi nhưng');
  }

  async function reportJobUpdate(jobId, changes) {
    await runtimeSendMessage({
      type: 'ZALO_MESSAGE_JOB_EVENT',
      data: {
        jobId: jobId,
        changes: changes,
      },
    });
  }

  async function runMessageBatch(jobs) {
    if (messageBatchRunning) {
      return { ok: false, error: 'Tab Zalo này đang chạy một batch nhắn tin khác.' };
    }

    try {
      apiAvailable = await ensureApiReady();
      console.log('[ZaloBridge] API probe result:', apiAvailable);
    } catch (_) {
      apiAvailable = false;
    }

    messageBatchRunning = true;
    try {
      for (var index = 0; index < jobs.length; index += 1) {
        var job = jobs[index];
        await reportJobUpdate(job.id, {
          status: 'running',
          statusLabel: 'Đang gửi ' + (index + 1) + '/' + jobs.length,
          startedAt: new Date().toISOString(),
        });

        try {
          await executeMessageJob(job);
          await reportJobUpdate(job.id, {
            status: 'sent',
            statusLabel: 'Đã gửi',
            sentAt: new Date().toISOString(),
          });
        } catch (error) {
          await reportJobUpdate(job.id, {
            status: 'failed',
            statusLabel: 'Gửi thất bại',
            error: error.message,
            failedAt: new Date().toISOString(),
          });
        }

        if (index < jobs.length - 1) {
          await sleep(getMessageDelay(job.delayWindow));
        }
      }

      return { ok: true };
    } finally {
      messageBatchRunning = false;
    }
  }

  window.addEventListener('__zalotool__', function (e) {
    try {
      var msg = JSON.parse(e.detail);
    } catch (_) { return; }

    if (msg.type === 'me')      collected.me = msg.data;
    if (msg.type === 'friends') collected.friends = msg.data;
    if (msg.type === 'groups')  collected.groups = msg.data;
    if (msg.type === 'session') collected.session = msg.data;

    if (msg.type === 'api_ready') {
      apiAvailable = !!(msg.data && msg.data.available);
      console.log('[ZaloBridge] Webpack API available:', apiAvailable);
    }

    // Forward real-time incoming messages to background → web app
    if (msg.type === 'incoming_messages' && Array.isArray(msg.data)) {
      runtimeSendMessage({
        type: 'ZALO_INCOMING_MESSAGES',
        data: msg.data,
      });
    }

    if (msg.type === 'session' && sent) {
      pushCollectedDataToBackground();
    }

    if (msg.type === 'done' && !sent) {
      sent = true;
      console.log('[ZaloBridge] Extraction done — sending to background');
      pushCollectedDataToBackground();
    }
  });

  // Allow background to ask for a re-extraction or run a real message batch.
  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg.type === 'ZALOTOOL_RE_EXTRACT') {
      sent = false;
      collected = { me: null, friends: null, groups: null, session: null };
      window.dispatchEvent(new CustomEvent('__zalotool_extract__'));
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'ZALOTOOL_RUN_MESSAGE_BATCH') {
      if (messageBatchRunning) {
        sendResponse({ ok: false, error: 'Tab Zalo này đang chạy một batch nhắn tin khác.' });
        return false;
      }

      runMessageBatch(Array.isArray(msg.data?.jobs) ? msg.data.jobs : []).catch(function () {
        // Job-level failures are already reported individually back to the web app.
      });
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'ZALOTOOL_API_REQUEST') {
      (async function () {
        try {
          await ensureApiReady();
          var request = msg.data || {};

          if (request.method === 'getMessageHistory') {
            var apiHistory = [];
            var apiHistoryError = null;
            var domHistory = [];
            var domHistoryError = null;

            await hydrateConversationForHistory(request);

            try {
              apiHistory = await callZaloApi(request.method, request.args || {});
            } catch (error) {
              apiHistoryError = error;
            }

            if (apiHistoryError || shouldFallbackMessageHistory(apiHistory)) {
              try {
                domHistory = await getMessageHistoryViaDom(request);
              } catch (error) {
                domHistoryError = error;
              }
            }

            if (Array.isArray(domHistory) && domHistory.length > 0) {
              if (apiHistoryError || !Array.isArray(apiHistory) || apiHistory.length === 0) {
                sendResponse({ ok: true, data: domHistory, source: 'dom' });
                return;
              }

              sendResponse({ ok: true, data: mergeApiHistoryWithDom(apiHistory, domHistory), source: 'api+dom' });
              return;
            }

            if (!apiHistoryError && Array.isArray(apiHistory) && apiHistory.length > 0) {
              sendResponse({ ok: true, data: apiHistory });
              return;
            }

            if (!apiHistoryError && domHistoryError) {
              sendResponse({ ok: true, data: apiHistory, warning: domHistoryError.message, source: 'api-empty' });
              return;
            }

            if (apiHistoryError && domHistoryError) {
              throw new Error(apiHistoryError.message + '. DOM fallback thất bại: ' + domHistoryError.message);
            }

            if (!apiHistoryError) {
              sendResponse({ ok: true, data: apiHistory, source: 'api-empty' });
              return;
            }

            throw apiHistoryError;
          }

          if (request.method === 'debugGetMessageHistory') {
            await hydrateConversationForHistory(request);
          }

          if (request.method === 'sendZText' && request.meta && request.meta.job) {
            var job = request.meta.job;
            var beforePreview = await getConversationPreviewViaApi(job.zid);
            var result = await callZaloApi(request.method, request.args || {});
            var verified = await verifyMessageDelivery(job, beforePreview);

            if (!verified.ok) {
              console.log('[ZaloBridge] API send not verified, falling back to hidden DOM send for', job.zid);
              try {
                await executeMessageJobViaDom(job);
                sendResponse({ ok: true, data: { fallback: 'dom', verified: true, apiResult: result } });
                return;
              } catch (domError) {
                var apiErrorCode = result && result.error_code;
                var apiHint = apiErrorCode ? ('Zalo API lỗi ' + apiErrorCode) : 'Zalo API trả về nhưng preview không cập nhật';
                throw new Error(apiHint + '. DOM fallback thất bại: ' + domError.message);
              }
            }

            sendResponse({ ok: true, data: { verified: true, apiResult: result, preview: verified.preview } });
            return;
          }

          var result = await callZaloApi(request.method, request.args || {});
          sendResponse({ ok: true, data: result });
        } catch (error) {
          sendResponse({ ok: false, error: error.message });
        }
      })();
      return true;
    }

    return false;
  });

  console.log('[ZaloBridge] Ready on', location.href);
})();
