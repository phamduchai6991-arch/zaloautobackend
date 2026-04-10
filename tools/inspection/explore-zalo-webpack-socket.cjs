/**
 * explore-zalo-webpack-socket.cjs
 * 
 * Access:
 * 1. _chatHandler._socket (WebSocket instance)
 * 2. webpackJsonp module cache for API service modules
 * 3. Hook worker postMessage to intercept API calls
 * 4. Find the actual sendMessage, addFriend, etc. functions
 */

const { chromium } = require('playwright');

(async () => {
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const ctx = browser.contexts()[0];
    const zaloPage = ctx.pages().find(p => p.url().includes('chat.zalo.me'));
    if (!zaloPage) { console.error('No Zalo page'); process.exit(1); }

    // ========== 1. WebSocket from _chatHandler._socket ==========
    console.log('========== WEBSOCKET FROM CHAT HANDLER ==========');
    const wsInfo = await zaloPage.evaluate(() => {
      const sp = window.$$afmc?.socketPolling;
      if (!sp) return { error: 'No socketPolling' };
      
      const result = {};
      
      for (const handlerName of ['_chatHandler', '_ctrlHandler']) {
        const handler = sp[handlerName];
        if (!handler) continue;
        
        const socket = handler._socket;
        if (!socket) { result[handlerName] = { _socket: 'null/undefined' }; continue; }
        
        result[handlerName + '._socket'] = {
          constructor: socket.constructor?.name,
          keys: Object.keys(socket).slice(0, 30)
        };
        
        // Get methods of the socket wrapper
        const methods = [];
        let proto = socket;
        while (proto && proto !== Object.prototype) {
          try {
            methods.push(...Object.getOwnPropertyNames(proto).filter(m => {
              try { return typeof proto[m] === 'function' && m !== 'constructor'; } catch { return false; }
            }));
          } catch {}
          proto = Object.getPrototypeOf(proto);
        }
        result[handlerName + '._socket_methods'] = [...new Set(methods)].slice(0, 50);
        
        // Look for WebSocket instance inside the socket wrapper
        for (const key of Object.keys(socket)) {
          const val = socket[key];
          if (val instanceof WebSocket) {
            result[handlerName + '._socket.' + key + '_WS'] = {
              url: val.url,
              readyState: val.readyState,
              protocol: val.protocol,
              extensions: val.extensions
            };
          } else if (val && typeof val === 'object') {
            // Check one level deeper
            try {
              for (const subKey of Object.keys(val).slice(0, 20)) {
                if (val[subKey] instanceof WebSocket) {
                  result[handlerName + '._socket.' + key + '.' + subKey + '_WS'] = {
                    url: val[subKey].url,
                    readyState: val[subKey].readyState
                  };
                }
              }
            } catch {}
          }
        }
        
        // Also check for ws-related string properties
        for (const key of Object.keys(socket)) {
          const val = socket[key];
          if (typeof val === 'string' && (val.startsWith('ws') || val.startsWith('http') || val.includes('zalo'))) {
            result[handlerName + '._socket_str_' + key] = val;
          }
        }
      }
      
      // Also check connectChatSocket/connectCtrSocket 
      for (const key of ['connectChatSocket', 'connectCtrSocket', 'connectChatPolling', 'connectCtrPolling']) {
        const conn = sp[key];
        if (!conn) continue;
        
        result[key] = {
          constructor: conn.constructor?.name,
          keys: Object.keys(conn).slice(0, 30)
        };
        
        for (const subKey of Object.keys(conn)) {
          const val = conn[subKey];
          if (val instanceof WebSocket) {
            result[key + '.' + subKey + '_WS'] = { url: val.url, readyState: val.readyState };
          }
          if (typeof val === 'string' && (val.startsWith('ws') || val.startsWith('http'))) {
            result[key + '_url_' + subKey] = val;
          }
        }
      }
      
      return result;
    });
    console.log(JSON.stringify(wsInfo, null, 2));

    // ========== 2. Explore webpackJsonp for API modules ==========
    console.log('\n========== WEBPACK API MODULES ==========');
    const wpModules = await zaloPage.evaluate(() => {
      const result = {};
      
      // webpackJsonp is an array of [chunkIds, modules] tuples
      if (!window.webpackJsonp) return { error: 'No webpackJsonp' };
      
      result.webpackJsonpLength = window.webpackJsonp.length;
      result.firstChunkStructure = window.webpackJsonp[0] ? {
        length: window.webpackJsonp[0].length,
        firstItemType: typeof window.webpackJsonp[0][0],
        // Usually [chunkIds, {moduleId: moduleFn, ...}]
      } : null;
      
      // Try to access the webpack require function via the module cache
      // In webpack 4, webpackJsonp has a push() override that gives us access
      let webpackRequire = null;
      try {
        // Method 1: Try to find __webpack_require__ on the window
        if (window.__webpack_require__) {
          webpackRequire = window.__webpack_require__;
        }
      } catch {}
      
      if (!webpackRequire) {
        // Method 2: Use webpackJsonp push trick
        try {
          const originalPush = window.webpackJsonp.push;
          let captured = null;
          window.webpackJsonp.push([[99999], {
            99999: function(module, exports, __webpack_require__) {
              captured = __webpack_require__;
            }
          }, [[99999]]]);
          if (captured) {
            webpackRequire = captured;
            // Restore
            window.webpackJsonp.pop();
          }
        } catch(e) {
          result.pushTrickError = e.message;
        }
      }
      
      if (!webpackRequire) {
        result.error = 'Could not get webpack require';
        return result;
      }
      
      result.webpackRequireFound = true;
      
      // Get module cache
      const moduleCache = webpackRequire.c;
      if (moduleCache) {
        const moduleIds = Object.keys(moduleCache);
        result.totalModules = moduleIds.length;
        
        // Search for modules with API/send/message methods
        const apiModules = [];
        
        for (const id of moduleIds) {
          try {
            const mod = moduleCache[id];
            if (!mod || !mod.exports) continue;
            
            const exp = mod.exports;
            const expDefault = exp.default || exp;
            
            if (!expDefault || typeof expDefault !== 'object') continue;
            
            // Check for key API method names
            const methods = [];
            try {
              if (typeof expDefault === 'function') {
                // It's a class/constructor
                const proto = expDefault.prototype;
                if (proto) {
                  methods.push(...Object.getOwnPropertyNames(proto).filter(m => m !== 'constructor'));
                }
              } else {
                methods.push(...Object.keys(expDefault).filter(k => typeof expDefault[k] === 'function'));
              }
            } catch {}
            
            const hasApi = methods.some(m => /^(send|get|fetch|post|create|delete|update|add|remove|block|unblock|accept|reject).*Message|Friend|Group|Conv/i.test(m));
            
            if (hasApi) {
              apiModules.push({
                moduleId: id,
                type: typeof expDefault,
                constructor: expDefault.constructor?.name,
                apiMethods: methods.filter(m => /send|get|fetch|post|create|delete|update|add|remove|block|unblock|accept|reject|friend|message|group|conv/i.test(m)).slice(0, 30)
              });
            }
          } catch {}
        }
        
        result.apiModules = apiModules;
        
        // Also search for modules with getFriendsList specifically
        const friendModules = [];
        for (const id of moduleIds) {
          try {
            const mod = moduleCache[id];
            if (!mod?.exports) continue;
            const exp = mod.exports.default || mod.exports;
            
            if (typeof exp === 'object' && exp !== null) {
              if (typeof exp.getFriendsList === 'function') {
                friendModules.push({
                  moduleId: id,
                  methods: Object.keys(exp).filter(k => typeof exp[k] === 'function').slice(0, 50)
                });
              }
            }
          } catch {}
        }
        result.friendModules = friendModules;
        
        // Search for modules with sendMessage
        const sendModules = [];
        for (const id of moduleIds) {
          try {
            const mod = moduleCache[id];
            if (!mod?.exports) continue;
            const exp = mod.exports.default || mod.exports;
            
            if (typeof exp === 'object' && exp !== null) {
              const keys = Object.keys(exp);
              if (keys.some(k => /sendMessage|sendMsg|sendText/i.test(k))) {
                sendModules.push({
                  moduleId: id,
                  methods: keys.filter(k => typeof exp[k] === 'function').slice(0, 50)
                });
              }
            }
          } catch {}
        }
        result.sendModules = sendModules;

        // Search for modules with encrypt/decrypt
        const cryptoModules = [];
        for (const id of moduleIds) {
          try {
            const mod = moduleCache[id];
            if (!mod?.exports) continue;
            const exp = mod.exports.default || mod.exports;
            
            if (typeof exp === 'object' && exp !== null) {
              const keys = Object.keys(exp);
              if (keys.some(k => /encrypt|decrypt|encryptParam|decryptParam/i.test(k))) {
                cryptoModules.push({
                  moduleId: id,
                  methods: keys.filter(k => typeof exp[k] === 'function').slice(0, 30)
                });
              }
            }
          } catch {}
        }
        result.cryptoModules = cryptoModules;
      }
      
      return result;
    });
    console.log(JSON.stringify(wpModules, null, 2));

    // ========== 3. If we found modules, get their method signatures ==========
    if (wpModules.friendModules?.length > 0 || wpModules.sendModules?.length > 0) {
      console.log('\n========== API MODULE DETAILS ==========');
      const moduleDetail = await zaloPage.evaluate((friendIds, sendIds) => {
        const result = {};
        
        // Re-get webpack require
        let wr = null;
        try {
          const originalPush = window.webpackJsonp.push;
          window.webpackJsonp.push([[99998], {
            99998: function(m, e, r) { wr = r; }
          }, [[99998]]]);
          window.webpackJsonp.pop();
        } catch {}
        
        if (!wr) return { error: 'No webpack require' };
        
        // Get friend list module details
        for (const id of friendIds) {
          try {
            const exp = wr(id).default || wr(id);
            result['friend_' + id] = {};
            for (const key of Object.keys(exp).filter(k => typeof exp[k] === 'function')) {
              result['friend_' + id][key] = exp[key].toString().slice(0, 400);
            }
          } catch(e) { result['friend_' + id + '_error'] = e.message; }
        }
        
        // Get send module details
        for (const id of sendIds) {
          try {
            const exp = wr(id).default || wr(id);
            result['send_' + id] = {};
            for (const key of Object.keys(exp).filter(k => typeof exp[k] === 'function')) {
              result['send_' + id][key] = exp[key].toString().slice(0, 400);
            }
          } catch(e) { result['send_' + id + '_error'] = e.message; }
        }
        
        return result;
      }, 
        (wpModules.friendModules || []).map(m => m.moduleId),
        (wpModules.sendModules || []).map(m => m.moduleId)
      );
      console.log(JSON.stringify(moduleDetail, null, 2));
    }

    console.log('\n========== DONE ==========');
  } catch(err) {
    console.error('Error:', err.message);
  } finally {
    if (browser) await browser.close();
  }
})();
