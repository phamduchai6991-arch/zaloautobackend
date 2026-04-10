/**
 * explore-zalo-api-deep.cjs
 * 
 * Deep exploration:
 * 1. AFMC Container _registry Map (class-token based DI)
 * 2. FriendListManager._callApi source & mechanics
 * 3. socketPolling handlers & WebSocket references
 * 4. Worker postMessage interception
 * 5. API encryption/params pattern
 */

const { chromium } = require('playwright');

(async () => {
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const ctx = browser.contexts()[0];
    const zaloPage = ctx.pages().find(p => p.url().includes('chat.zalo.me'));
    if (!zaloPage) { console.error('No Zalo page'); process.exit(1); }

    // ========== 1. AFMC Container _registry ==========
    console.log('========== AFMC CONTAINER _REGISTRY ==========');
    const registry = await zaloPage.evaluate(() => {
      const c = window.$$AFMC_Container;
      if (!c) return { error: 'No container' };
      
      const result = {};
      // The _registry is a Map with constructors/symbols as keys
      if (c._registry instanceof Map) {
        result.registrySize = c._registry.size;
        result.entries = [];
        for (const [key, val] of c._registry) {
          const entry = {
            keyType: typeof key,
            keyName: typeof key === 'function' ? key.name : 
                     typeof key === 'symbol' ? key.toString() : String(key)
          };
          
          if (val && typeof val === 'object') {
            entry.valueType = typeof val;
            entry.valueKeys = Object.keys(val).slice(0, 10);
            // Check if it's a factory or instance
            if (typeof val.factory === 'function') entry.isFactory = true;
            if (val.instance) {
              entry.instanceConstructor = val.instance.constructor?.name;
              const methods = [];
              let proto = val.instance;
              while (proto && proto !== Object.prototype) {
                try {
                  methods.push(...Object.getOwnPropertyNames(proto).filter(m => {
                    try { return typeof proto[m] === 'function' && m !== 'constructor'; } catch { return false; }
                  }));
                } catch {}
                proto = Object.getPrototypeOf(proto);
              }
              entry.instanceMethods = [...new Set(methods)].slice(0, 30);
            }
          }
          
          result.entries.push(entry);
        }
      }
      
      // Also check interceptors
      if (c.interceptors) {
        result.interceptorsType = typeof c.interceptors;
        if (c.interceptors instanceof Map) result.interceptorsSize = c.interceptors.size;
        else if (Array.isArray(c.interceptors)) result.interceptorsLength = c.interceptors.length;
      }
      
      return result;
    });
    console.log(JSON.stringify(registry, null, 2));

    // ========== 2. FriendListManager deep dive ==========
    console.log('\n========== FRIEND LIST MANAGER ==========');
    const flm = await zaloPage.evaluate(() => {
      const mgr = window.FriendListManager;
      if (!mgr) return { error: 'No FriendListManager' };
      
      const result = {};
      
      // Get all methods with source
      const methods = ['_callApi', '_request', '_newRequest', 'forceRequestGetFriendList',
                       '_signalCallback', '_isRequestSingle', '_clearTimerRequest', '_setTimerRequest'];
      for (const m of methods) {
        try {
          result[m + '_source'] = mgr[m]?.toString().slice(0, 500);
        } catch {}
      }
      
      // Get all own properties and their types
      result.ownProps = {};
      for (const key of Object.keys(mgr)) {
        const val = mgr[key];
        result.ownProps[key] = {
          type: typeof val,
          value: typeof val === 'string' ? val.slice(0, 100) :
                 typeof val === 'number' || typeof val === 'boolean' ? val :
                 typeof val === 'object' && val !== null ? val.constructor?.name : 
                 String(val)
        };
      }
      
      return result;
    });
    console.log(JSON.stringify(flm, null, 2));

    // ========== 3. SocketPolling handlers ==========
    console.log('\n========== SOCKET POLLING HANDLERS ==========');
    const sp = await zaloPage.evaluate(() => {
      const afmc = window.$$afmc;
      if (!afmc?.socketPolling) return { error: 'No socketPolling' };
      
      const sp = afmc.socketPolling;
      const result = {};
      
      // Examine chat and ctrl handlers
      for (const handlerName of ['_chatHandler', '_ctrlHandler']) {
        const h = sp[handlerName];
        if (!h) { result[handlerName] = null; continue; }
        
        result[handlerName] = {
          constructor: h.constructor?.name,
          keys: Object.keys(h).slice(0, 30),
          methods: []
        };
        
        let proto = h;
        while (proto && proto !== Object.prototype) {
          try {
            result[handlerName].methods.push(
              ...Object.getOwnPropertyNames(proto).filter(m => {
                try { return typeof proto[m] === 'function' && m !== 'constructor'; } catch { return false; }
              })
            );
          } catch {}
          proto = Object.getPrototypeOf(proto);
        }
        result[handlerName].methods = [...new Set(result[handlerName].methods)].slice(0, 50);
        
        // Look for WebSocket, URL, or connection properties
        for (const key of Object.keys(h)) {
          const val = h[key];
          if (val instanceof WebSocket) {
            result[handlerName + '_ws_' + key] = { url: val.url, readyState: val.readyState };
          } else if (typeof val === 'string' && (val.startsWith('ws') || val.startsWith('http'))) {
            result[handlerName + '_url_' + key] = val;
          }
        }
      }
      
      // Connection types
      result.chatConnectType = sp.chatConnectType;
      result.ctrlConnectType = sp.ctrlConnectType;
      
      // Check socket references
      for (const key of ['connectChatSocket', 'connectChatPolling', 'connectCtrSocket', 'connectCtrPolling']) {
        const val = sp[key];
        if (val && typeof val === 'object') {
          result[key] = {
            constructor: val.constructor?.name,
            keys: Object.keys(val).slice(0, 20),
            methods: []
          };
          let proto = val;
          while (proto && proto !== Object.prototype) {
            try {
              result[key].methods.push(
                ...Object.getOwnPropertyNames(proto).filter(m => {
                  try { return typeof proto[m] === 'function' && m !== 'constructor'; } catch { return false; }
                })
              );
            } catch {}
            proto = Object.getPrototypeOf(proto);
          }
          result[key].methods = [...new Set(result[key].methods)].slice(0, 30);
          
          // Find WS URL
          for (const subKey of Object.keys(val)) {
            if (val[subKey] instanceof WebSocket) {
              result[key + '_ws'] = { url: val[subKey].url, readyState: val[subKey].readyState };
            }
            if (typeof val[subKey] === 'string' && (val[subKey].startsWith('ws') || val[subKey].startsWith('http'))) {
              result[key + '_url_' + subKey] = val[subKey];
            }
          }
        }
      }
      
      return result;
    });
    console.log(JSON.stringify(sp, null, 2));

    // ========== 4. Find the actual API call mechanism ==========
    console.log('\n========== API CALL MECHANISM ==========');
    const apiMech = await zaloPage.evaluate(() => {
      const result = {};
      
      // Look at how tt-*-wpa.chat.zalo.me endpoints are called
      // These use encrypted params - find the encryption function
      
      // Check for zpw (Zalo PC Web) related globals
      const zpwGlobals = [];
      for (const key of Object.getOwnPropertyNames(window)) {
        if (/zpw|zalo.*api|api.*zalo|encrypt|decrypt|crypto|cipher/i.test(key)) {
          zpwGlobals.push(key);
        }
      }
      result.zpwGlobals = zpwGlobals;
      
      // Look for API module in webpack chunks
      // Check if there's a webpackJsonp or __webpack_modules__
      result.hasWebpackChunk = !!window.webpackChunk;
      result.hasWebpackJsonp = !!window.webpackJsonp;
      result.hasWebpackModules = !!window.__webpack_modules__;
      result.hasChunkWebpackChat = typeof window.webpackChunkchat_zalo_me !== 'undefined';
      
      // Scan for 'zpw_ver' or 'zpw_type' in function sources of key objects
      const FLM = window.FriendListManager;
      if (FLM) {
        // Walk up the prototype to find who does the actual XHR
        let proto = FLM;
        while (proto && proto !== Object.prototype) {
          for (const key of Object.getOwnPropertyNames(proto)) {
            try {
              const fn = proto[key];
              if (typeof fn === 'function') {
                const src = fn.toString();
                if (src.includes('zpw_ver') || src.includes('zpw_type') || src.includes('params=') || src.includes('XMLHttpRequest') || src.includes('fetch(')) {
                  result['FLM_' + key + '_hasApiCall'] = src.slice(0, 500);
                }
              }
            } catch {}
          }
          proto = Object.getPrototypeOf(proto);
        }
      }
      
      // Check the VerifyFriendsManager similarly
      const VFM = window.VerifyFriendsManager;
      if (VFM) {
        let proto = VFM;
        while (proto && proto !== Object.prototype) {
          for (const key of Object.getOwnPropertyNames(proto)) {
            try {
              const fn = proto[key];
              if (typeof fn === 'function') {
                const src = fn.toString();
                if (src.includes('zpw_ver') || src.includes('zpw_type') || src.includes('fetch(') || src.includes('XMLHttpRequest')) {
                  result['VFM_' + key + '_hasApiCall'] = src.slice(0, 500);
                }
              }
            } catch {}
          }
          proto = Object.getPrototypeOf(proto);
        }
      }
      
      return result;
    });
    console.log(JSON.stringify(apiMech, null, 2));

    // ========== 5. Trace actionlogService ==========
    console.log('\n========== ACTIONLOG SERVICE ==========');
    const actionlog = await zaloPage.evaluate(() => {
      const als = window.$$afmc?.actionlogService;
      if (!als) return { error: 'No actionlogService' };
      
      const result = {
        constructor: als.constructor?.name,
        keys: Object.keys(als),
        methods: []
      };
      
      let proto = als;
      while (proto && proto !== Object.prototype) {
        try {
          result.methods.push(
            ...Object.getOwnPropertyNames(proto).filter(m => {
              try { return typeof proto[m] === 'function' && m !== 'constructor'; } catch { return false; }
            })
          );
        } catch {}
        proto = Object.getPrototypeOf(proto);
      }
      result.methods = [...new Set(result.methods)];
      
      // Get source of interesting methods
      result.sources = {};
      for (const m of result.methods.slice(0, 10)) {
        try {
          result.sources[m] = als[m].toString().slice(0, 300);
        } catch {}
      }
      
      return result;
    });
    console.log(JSON.stringify(actionlog, null, 2));

    // ========== 6. Look at importantMessageManager.apiRequests ==========
    console.log('\n========== IMPORTANT MESSAGE MANAGER API ==========');
    const impMsg = await zaloPage.evaluate(() => {
      const imm = window.$$afmc?.importantMessageManager;
      if (!imm) return { error: 'No importantMessageManager' };
      
      const result = {
        apiRequestsType: typeof imm.apiRequests,
        apiRequestsConstructor: imm.apiRequests?.constructor?.name
      };
      
      if (imm.apiRequests && typeof imm.apiRequests === 'object') {
        result.apiRequestsKeys = Object.keys(imm.apiRequests).slice(0, 20);
        result.apiRequestsMethods = [];
        let proto = imm.apiRequests;
        while (proto && proto !== Object.prototype) {
          try {
            result.apiRequestsMethods.push(
              ...Object.getOwnPropertyNames(proto).filter(m => {
                try { return typeof proto[m] === 'function' && m !== 'constructor'; } catch { return false; }
              })
            );
          } catch {}
          proto = Object.getPrototypeOf(proto);
        }
        result.apiRequestsMethods = [...new Set(result.apiRequestsMethods)].slice(0, 30);
        
        // Get sources of api methods
        result.apiSources = {};
        for (const m of result.apiRequestsMethods.filter(m => /call|request|fetch|send|api|get|post/i.test(m)).slice(0, 10)) {
          try {
            result.apiSources[m] = imm.apiRequests[m].toString().slice(0, 500);
          } catch {}
        }
      }
      
      // Also look at _callFetchImpMsgRequest source
      try {
        result._callFetchImpMsgRequest_src = imm._callFetchImpMsgRequest.toString().slice(0, 1000);
      } catch {}
      
      return result;
    });
    console.log(JSON.stringify(impMsg, null, 2));

    console.log('\n========== DONE ==========');
  } catch(err) {
    console.error('Error:', err.message);
  } finally {
    if (browser) await browser.close();
  }
})();
