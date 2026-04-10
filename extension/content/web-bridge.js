/* ISOLATED world on the deployed web app.
   Bridges postMessage (page) <-> chrome.runtime (background). */

(function () {
  'use strict';

  var runtimeAvailable = true;
  var runtimeUnavailableNotified = false;
  var runtimePort = null;
  var reconnectTimer = null;
  var reconnectAttempts = 0;
  var MAX_RECONNECT_ATTEMPTS = 5;
  var allowedWebAppPatterns = getAllowedWebAppPatterns();

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function compileMatchPattern(pattern) {
    var match = String(pattern || '').match(/^(\*|https?|http):\/\/([^/]+)(\/.*)$/i);
    if (!match) return null;

    var schemePart = match[1];
    var hostPart = match[2];
    var pathPart = match[3];
    var scheme = schemePart === '*' ? 'https?' : escapeRegex(schemePart);
    var host = '';

    if (hostPart === '*') {
      host = '[^/]+?';
    } else if (hostPart.indexOf('*.') === 0) {
      host = '(?:[^./]+\\.)*' + escapeRegex(hostPart.slice(2));
    } else {
      host = escapeRegex(hostPart);
    }

    var port = '(?::\\d+)?';
    var path = escapeRegex(pathPart).replace(/\\\*/g, '.*');
    return new RegExp('^' + scheme + ':\\/\\/' + host + port + path + '$', 'i');
  }

  function getAllowedWebAppPatterns() {
    try {
      var manifest = chrome.runtime.getManifest();
      var hostPermissions = Array.isArray(manifest && manifest.host_permissions) ? manifest.host_permissions : [];
      return hostPermissions
        .filter(function (pattern) {
          return /^https?:\/\//i.test(pattern) && !/zalo\.me/i.test(pattern);
        })
        .map(function (pattern) {
          return compileMatchPattern(pattern);
        })
        .filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  function isAllowedWebAppUrl(url) {
    // If no patterns loaded (getManifest unavailable), fall back to localhost-only check.
    if (allowedWebAppPatterns.length === 0) {
      return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url);
    }

    try {
      var normalizedUrl = new URL(url).href;
      return allowedWebAppPatterns.some(function (regex) {
        return regex.test(normalizedUrl);
      });
    } catch (_) {
      return false;
    }
  }

  function handleRuntimeDisconnect() {
    runtimePort = null;
    // MV3 service worker goes idle after ~30s — try to reconnect silently
    attemptReconnect();
  }

  function attemptReconnect() {
    if (reconnectTimer) return;
    reconnectAttempts++;

    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      markRuntimeUnavailable('Extension context invalidated. Hãy tải lại trang sau khi reload extension.');
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s
    var delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 16000);
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;

      try {
        if (!chrome || !chrome.runtime || !chrome.runtime.id) {
          // Extension truly unloaded — give up
          markRuntimeUnavailable('Extension context invalidated. Hãy tải lại trang sau khi reload extension.');
          return;
        }

        runtimePort = chrome.runtime.connect({ name: 'zalotool-web-bridge' });
        if (runtimePort && runtimePort.onDisconnect) {
          runtimePort.onDisconnect.addListener(handleRuntimeDisconnect);
        }

        // Test the connection with a ping
        chrome.runtime.sendMessage({ type: 'ZALOTOOL_CHECK' }, function (resp) {
          var err = chrome.runtime && chrome.runtime.lastError;
          if (err || !resp) {
            runtimePort = null;
            attemptReconnect();
            return;
          }

          // Reconnected successfully
          reconnectAttempts = 0;
          runtimeAvailable = true;
          runtimeUnavailableNotified = false;
          console.log('[WebBridge] Reconnected to service worker');
          postToPage('ZALOTOOL_READY');
        });
      } catch (_) {
        attemptReconnect();
      }
    }, delay);
  }

  function ensureRuntimePort() {
    if (runtimePort) return runtimePort;

    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.connect) {
        return null;
      }

      runtimePort = chrome.runtime.connect({ name: 'zalotool-web-bridge' });
      if (runtimePort && runtimePort.onDisconnect) {
        runtimePort.onDisconnect.addListener(handleRuntimeDisconnect);
      }
      return runtimePort;
    } catch (_) {
      runtimePort = null;
      return null;
    }
  }

  function postToPage(type, data) {
    window.postMessage({ source: 'ZALOTOOL_EXT', type: type, data: data }, '*');
  }

  function getRuntimeUnavailableMessage(error) {
    var message = String(error && error.message ? error.message : error || 'Extension context invalidated.').trim();
    if (!message) message = 'Extension context invalidated.';
    return message;
  }

  function markRuntimeUnavailable(error) {
    if (runtimeUnavailableNotified) {
      runtimeAvailable = false;
      return getRuntimeUnavailableMessage(error);
    }

    runtimeAvailable = false;
    runtimeUnavailableNotified = true;
    var message = getRuntimeUnavailableMessage(error);
    postToPage('ZALOTOOL_EXTENSION_INVALIDATED', { ok: false, error: message });
    return message;
  }

  function canUseRuntime() {
    // If previously marked unavailable, check if runtime is back
    if (!runtimeAvailable || runtimeUnavailableNotified) {
      try {
        if (chrome && chrome.runtime && chrome.runtime.id) {
          // Runtime exists again — reset and reconnect
          runtimeAvailable = true;
          runtimeUnavailableNotified = false;
          reconnectAttempts = 0;
          return Boolean(ensureRuntimePort());
        }
      } catch (_) {}
      return false;
    }

    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.id) {
        return false;
      }

      return Boolean(ensureRuntimePort());
    } catch (_) {
      return false;
    }
  }

  function safeSendRuntimeMessage(message, callback) {
    if (!canUseRuntime()) {
      // Instead of immediately failing, try reconnect in background
      if (!reconnectTimer && reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
        attemptReconnect();
      }
      var unavailableMessage = 'Extension đang kết nối lại...';
      if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        unavailableMessage = markRuntimeUnavailable('Extension context invalidated. Hãy tải lại trang sau khi reload extension.');
      }
      if (typeof callback === 'function') {
        callback({ ok: false, error: unavailableMessage }, unavailableMessage);
      }
      return;
    }

    try {
      chrome.runtime.sendMessage(message, function (response) {
        var lastError = chrome.runtime && chrome.runtime.lastError;
        if (lastError) {
          // Don't permanently mark unavailable — try reconnect
          runtimePort = null;
          attemptReconnect();
          if (typeof callback === 'function') {
            callback({ ok: false, error: 'Extension đang kết nối lại...' }, 'Extension đang kết nối lại...');
          }
          return;
        }

        runtimeAvailable = true;
        runtimeUnavailableNotified = false;
        ensureRuntimePort();
        if (typeof callback === 'function') {
          callback(response || { ok: true }, null);
        }
      });
    } catch (error) {
      runtimePort = null;
      attemptReconnect();
      var sendError = 'Extension đang kết nối lại...';
      if (typeof callback === 'function') {
        callback({ ok: false, error: sendError }, sendError);
      }
    }
  }

  function isZaloToolWebApp() {
    var marker = document.querySelector('meta[name="zalotool-web-app"][content="enabled"]');
    return !!marker;
  }

  if (!isZaloToolWebApp()) {
    console.log('[WebBridge] Not a ZaloTool web app (missing meta tag), exiting.');
    return;
  }

  console.log('[WebBridge] Meta tag found, initializing on', location.href);
  ensureRuntimePort();

  // Tell background this tab is a web-app tab
  safeSendRuntimeMessage({ type: 'WEB_BRIDGE_INIT' }, function (resp, error) {
    console.log('[WebBridge] WEB_BRIDGE_INIT response:', resp, 'error:', error);
    if (error || resp?.ok === false) {
      return;
    }

    // Tell the page that the extension is installed and connected.
    postToPage('ZALOTOOL_READY');
  });

  /* ---- Page -> Background ---- */
  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || e.data.source !== 'ZALOTOOL_PAGE') return;
    var msg = e.data;

    // Extension check
    if (msg.type === 'ZALOTOOL_CHECK') {
      safeSendRuntimeMessage({ type: 'ZALOTOOL_CHECK' }, function (resp, error) {
        if (error || resp?.active !== true) {
          return;
        }

        postToPage('ZALOTOOL_CHECK_OK', { version: resp.version || '1.0.0' });
      });
      return;
    }

    // Forward to background
    safeSendRuntimeMessage({ type: msg.type, data: msg.data }, function (resp, error) {
      if (error) {
        postToPage(msg.type + '_RESPONSE', { ok: false, error: error });
        return;
      }

      // Always post response back (even if falsy, so requestExtension doesn't time out)
      postToPage(msg.type + '_RESPONSE', resp || { ok: true });
    });
  });

  /* ---- Background -> Page ---- */
  try {
    chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
      // Relay to page
      postToPage(msg.type, msg.data);
      sendResponse({ ok: true });
    });
  } catch (error) {
    markRuntimeUnavailable(error);
  }

  console.log('[WebBridge] Ready on', location.href);
})();
