/**
 * explore-zalo-api-layer.cjs
 * 
 * Focused exploration of Zalo's API layer:
 * 1. AFMC Container service resolution
 * 2. Global API objects with send/request methods
 * 3. Worker/socket references
 * 4. Message sending function discovery
 */

const { chromium } = require('playwright');

(async () => {
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const ctx = browser.contexts()[0];
    const zaloPage = ctx.pages().find(p => p.url().includes('chat.zalo.me'));
    if (!zaloPage) { console.error('No Zalo page'); process.exit(1); }

    // ========== 1. Container resolve ==========
    console.log('========== AFMC CONTAINER RESOLVE ==========');
    const resolveResult = await zaloPage.evaluate(() => {
      const c = window.$$AFMC_Container;
      if (!c || typeof c.resolve !== 'function') return { error: 'No resolve' };
      
      const result = {};
      const names = [
        'api', 'Api', 'API', 'http', 'Http', 'HTTP',
        'ws', 'Ws', 'websocket', 'WebSocket', 'socket', 'Socket',
        'chat', 'Chat', 'message', 'Message', 'MessageService',
        'friend', 'Friend', 'FriendService', 'friendService',
        'group', 'Group', 'GroupService',
        'network', 'Network', 'request', 'Request',
        'auth', 'Auth', 'user', 'User',
        'send', 'Send', 'sender', 'Sender',
        'conversation', 'Conversation',
        'contact', 'Contact',
        'transport', 'Transport',
        'connection', 'Connection',
        'client', 'Client',
        'proxy', 'Proxy',
        'service', 'Service',
        'dispatcher', 'Dispatcher',
        'eventBus', 'EventBus',
        'emitter', 'Emitter',
      ];
      
      for (const name of names) {
        try {
          const svc = c.resolve(name);
          if (svc != null) {
            result[name] = {
              type: typeof svc,
              constructor: svc?.constructor?.name,
              keys: typeof svc === 'object' ? Object.keys(svc).slice(0, 40) : null,
              methods: typeof svc === 'object' ? 
                Object.getOwnPropertyNames(Object.getPrototypeOf(svc))
                  .filter(m => m !== 'constructor').slice(0, 40) : null
            };
          }
        } catch(e) { result[name] = { error: e.message.slice(0, 100) }; }
      }
      
      // Also try resolve with symbol keys if the container uses DI tokens
      const ownProps = Object.getOwnPropertyNames(c);
      result._containerProps = ownProps;
      
      // Check if container has a _registry or similar
      for (const prop of ownProps) {
        const val = c[prop];
        if (val instanceof Map) {
          result['_map_' + prop + '_size'] = val.size;
          result['_map_' + prop + '_keys'] = [...val.keys()].slice(0, 50).map(k => {
            if (typeof k === 'symbol') return k.toString();
            if (typeof k === 'function') return k.name || 'anonymous_fn';
            return String(k);
          });
        }
      }

      return result;
    });
    console.log(JSON.stringify(resolveResult, null, 2));

    // ========== 2. Global API objects ==========
    console.log('\n========== GLOBAL API OBJECTS ==========');
    const apiObjects = await zaloPage.evaluate(() => {
      const result = {};
      const globals = ['$$afmc', 'FriendListManager', 'VerifyFriendsManager', '$zFileManager', 'ZaloLoginWidget'];
      
      for (const name of globals) {
        const obj = window[name];
        if (!obj) continue;
        
        const allMethods = new Set();
        let proto = obj;
        while (proto && proto !== Object.prototype) {
          for (const k of Object.getOwnPropertyNames(proto)) {
            try { if (typeof proto[k] === 'function') allMethods.add(k); } catch {}
          }
          proto = Object.getPrototypeOf(proto);
        }
        
        const actionMethods = [...allMethods].filter(m => 
          /send|request|fetch|post|call|invoke|emit|dispatch|api|upload|delete|create|add|remove|block|unblock|accept|reject|forward|reply|recall|unfriend|stranger/i.test(m)
        ).sort();
        
        if (actionMethods.length > 0) {
          result[name] = actionMethods;
        }
      }
      return result;
    });
    console.log(JSON.stringify(apiObjects, null, 2));

    // ========== 3. $$afmc keys and subobjects with action capabilities ==========
    console.log('\n========== $$AFMC TOP-LEVEL KEYS ==========');
    const afmcKeys = await zaloPage.evaluate(() => {
      const afmc = window.$$afmc;
      if (!afmc) return {};
      return Object.keys(afmc).map(k => ({
        key: k,
        type: typeof afmc[k],
        constructor: afmc[k]?.constructor?.name
      }));
    });
    console.log(JSON.stringify(afmcKeys, null, 2));

    // ========== 4. Find the actual send message function ==========
    console.log('\n========== MESSAGE SEND DISCOVERY ==========');
    const sendDiscovery = await zaloPage.evaluate(() => {
      const afmc = window.$$afmc;
      if (!afmc) return { error: 'No $$afmc' };
      
      const result = {};
      
      // Look for objects with 'send' in their key names
      for (const key of Object.keys(afmc)) {
        if (/send|message|chat|api|transport|socket|ws|client|proxy|request/i.test(key)) {
          const val = afmc[key];
          if (!val || typeof val !== 'object') {
            result[key] = { type: typeof val, value: String(val).slice(0, 100) };
            continue;
          }
          
          const methods = new Set();
          let proto = val;
          while (proto && proto !== Object.prototype) {
            try {
              for (const m of Object.getOwnPropertyNames(proto)) {
                try { if (typeof proto[m] === 'function') methods.add(m); } catch {}
              }
            } catch {}
            proto = Object.getPrototypeOf(proto);
          }
          
          result[key] = {
            constructor: val.constructor?.name,
            ownKeys: Object.keys(val).slice(0, 30),
            methods: [...methods].filter(m => m !== 'constructor').slice(0, 50)
          };
        }
      }
      
      // Check zStorage for sendMessage-like methods
      if (afmc.zStorage) {
        const zs = afmc.zStorage;
        const sendMethods = [];
        let proto = zs;
        while (proto && proto !== Object.prototype) {
          try {
            for (const m of Object.getOwnPropertyNames(proto)) {
              try {
                if (typeof proto[m] === 'function' && /send|forward|reply|post|submit|dispatch|emit|execute|invoke|call.*api/i.test(m)) {
                  sendMethods.push(m);
                  // Get first 200 chars of function source
                }
              } catch {}
            }
          } catch {}
          proto = Object.getPrototypeOf(proto);
        }
        result.zStorage_sendMethods = sendMethods;
        
        // Get signatures for the most interesting ones
        result.zStorage_signatures = {};
        for (const m of sendMethods.slice(0, 20)) {
          try {
            result.zStorage_signatures[m] = zs[m].toString().slice(0, 300);
          } catch {}
        }
      }
      
      return result;
    });
    console.log(JSON.stringify(sendDiscovery, null, 2));

    // ========== 5. Find worker/service worker that handles API ==========
    console.log('\n========== WORKERS & SERVICE WORKERS ==========');
    const workerInfo = await zaloPage.evaluate(() => {
      const result = {};
      
      // Check navigator.serviceWorker
      if (navigator.serviceWorker?.controller) {
        result.serviceWorker = {
          scriptURL: navigator.serviceWorker.controller.scriptURL,
          state: navigator.serviceWorker.controller.state
        };
      }
      
      // Check for SharedWorker references
      result.sharedWorkerRefs = [];
      
      // Look for postMessage patterns in $$afmc
      const afmc = window.$$afmc;
      if (afmc) {
        for (const key of Object.keys(afmc)) {
          const val = afmc[key];
          if (val && typeof val === 'object') {
            for (const subKey of Object.keys(val).slice(0, 30)) {
              try {
                if (val[subKey] instanceof Worker || val[subKey] instanceof SharedWorker) {
                  result[key + '.' + subKey] = 'Worker instance found!';
                }
                if (val[subKey] && typeof val[subKey].postMessage === 'function' && !(val[subKey] instanceof Window)) {
                  result[key + '.' + subKey + '_postMessage'] = {
                    constructor: val[subKey].constructor?.name,
                    type: 'Has postMessage'
                  };
                }
              } catch {}
            }
          }
        }
      }
      
      return result;
    });
    console.log(JSON.stringify(workerInfo, null, 2));

    // ========== 6. Intercept & inspect the XHR/fetch wrappers ==========
    console.log('\n========== XHR/FETCH WRAPPER DISCOVERY ==========');
    const fetchWrap = await zaloPage.evaluate(() => {
      // Check if fetch or XMLHttpRequest have been patched
      const result = {};
      result.fetchIsNative = fetch.toString().includes('[native code]');
      result.xhrOpenIsNative = XMLHttpRequest.prototype.open.toString().includes('[native code]');
      result.xhrSendIsNative = XMLHttpRequest.prototype.send.toString().includes('[native code]');
      
      // Look for zpwRequest, apiRequest or similar  
      const searchNames = ['zpwRequest', 'apiRequest', 'httpRequest', 'zaloRequest', 'sendRequest'];
      for (const name of searchNames) {
        if (window[name]) result[name] = typeof window[name];
      }
      
      return result;
    });
    console.log(JSON.stringify(fetchWrap, null, 2));

    // ========== 7. Decode the WebSocket heartbeat ==========
    console.log('\n========== WEBSOCKET FRAME DECODE ==========');
    const wsDecode = await zaloPage.evaluate(() => {
      // Decode the base64 WS frame we captured
      const b64 = 'AQQAAXsiYXQiOjIsInJlcUlkIjoiY21kXzQifQ==';
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const text = new TextDecoder().decode(bytes);
      
      // Find JSON part
      const jsonStart = text.indexOf('{');
      const jsonPart = jsonStart >= 0 ? text.slice(jsonStart) : null;
      
      return {
        rawBytes: Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' '),
        text: text,
        jsonPart: jsonPart,
        parsed: jsonPart ? JSON.parse(jsonPart) : null,
        headerBytes: Array.from(bytes.slice(0, jsonStart >= 0 ? jsonStart : 4)).map(b => b.toString(16).padStart(2, '0')).join(' ')
      };
    });
    console.log(JSON.stringify(wsDecode, null, 2));

    console.log('\n========== DONE ==========');
  } catch(err) {
    console.error('Error:', err.message);
  } finally {
    if (browser) await browser.close();
  }
})();
