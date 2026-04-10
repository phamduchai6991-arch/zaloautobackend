/**
 * intercept-zalo-network.cjs
 * 
 * Intercepts WebSocket frames, XHR/Fetch requests, and explores
 * $$AFMC_Container services to find the real API layer.
 * 
 * Usage: node tools/inspection/intercept-zalo-network.cjs [duration_seconds]
 * Default duration: 30 seconds
 */

const { chromium } = require('playwright');

const DURATION = (parseInt(process.argv[2]) || 30) * 1000;

(async () => {
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const contexts = browser.contexts();
    if (!contexts.length) { console.error('No browser contexts'); process.exit(1); }
    
    const pages = contexts[0].pages();
    const zaloPage = pages.find(p => p.url().includes('chat.zalo.me'));
    if (!zaloPage) { console.error('No Zalo page found'); process.exit(1); }

    console.log('Connected to:', zaloPage.url());

    // ========== 1. Explore $$AFMC_Container registry ==========
    console.log('\n========== AFMC CONTAINER DEEP EXPLORATION ==========');
    const containerInfo = await zaloPage.evaluate(() => {
      const result = {};
      const c = window.$$AFMC_Container;
      if (!c) return { error: 'No $$AFMC_Container' };
      
      // Get all properties and methods
      result.ownProps = Object.getOwnPropertyNames(c);
      result.protoProps = Object.getOwnPropertyNames(Object.getPrototypeOf(c));
      
      // Try to find registry/map of services
      for (const key of result.ownProps) {
        const val = c[key];
        if (val instanceof Map) {
          result[key + '_mapKeys'] = [...val.keys()].slice(0, 100);
          // Try to get first few entries' types
          const entries = [];
          let i = 0;
          for (const [k, v] of val) {
            if (i++ >= 10) break;
            entries.push({
              key: String(k),
              keyType: typeof k,
              valueType: typeof v,
              valueKeys: v && typeof v === 'object' ? Object.keys(v).slice(0, 20) : null,
              valueMethods: v && typeof v === 'object' ? Object.getOwnPropertyNames(Object.getPrototypeOf(v)).slice(0, 20) : null
            });
          }
          result[key + '_sample'] = entries;
        } else if (val instanceof Set) {
          result[key + '_setSize'] = val.size;
          result[key + '_setSample'] = [...val].slice(0, 20).map(String);
        } else if (Array.isArray(val)) {
          result[key + '_arrayLen'] = val.length;
          result[key + '_arraySample'] = val.slice(0, 10).map(v => typeof v === 'object' ? Object.keys(v).slice(0, 10) : String(v));
        } else if (typeof val === 'object' && val !== null) {
          result[key + '_keys'] = Object.keys(val).slice(0, 50);
        }
      }

      // Try resolve with common service names
      if (typeof c.resolve === 'function') {
        const tryResolve = (name) => {
          try {
            const svc = c.resolve(name);
            if (svc) return {
              type: typeof svc,
              keys: typeof svc === 'object' ? Object.keys(svc).slice(0, 30) : null,
              methods: typeof svc === 'object' ? Object.getOwnPropertyNames(Object.getPrototypeOf(svc)).filter(m => m !== 'constructor').slice(0, 30) : null
            };
          } catch(e) { return { error: e.message }; }
          return null;
        };

        // Try various service names
        const serviceNames = [
          'api', 'Api', 'API', 'http', 'Http', 'HTTP',
          'ws', 'Ws', 'websocket', 'WebSocket', 'socket', 'Socket',
          'chat', 'Chat', 'message', 'Message', 'MessageService',
          'friend', 'Friend', 'FriendService',
          'group', 'Group', 'GroupService',
          'network', 'Network', 'request', 'Request',
          'auth', 'Auth', 'user', 'User',
          'zStorage', 'ZStorage', 'storage', 'Storage',
          'send', 'Send', 'sender', 'Sender',
          'conversation', 'Conversation',
          'contact', 'Contact',
          'file', 'File', 'upload', 'Upload',
          'notification', 'Notification',
        ];
        
        result.resolvedServices = {};
        for (const name of serviceNames) {
          const r = tryResolve(name);
          if (r && !r.error) result.resolvedServices[name] = r;
        }
      }

      return result;
    });
    console.log(JSON.stringify(containerInfo, null, 2));

    // ========== 2. Find global objects with send/request/fetch methods ==========
    console.log('\n========== GLOBAL API OBJECTS ==========');
    const apiObjects = await zaloPage.evaluate(() => {
      const result = {};
      
      // Known important globals
      const globals = ['$$afmc', '$$AFMC_Container', 'FriendListManager', 'VerifyFriendsManager', '$zFileManager', 'ZaloLoginWidget'];
      
      for (const name of globals) {
        const obj = window[name];
        if (!obj) continue;
        
        const allMethods = [];
        let proto = obj;
        while (proto && proto !== Object.prototype) {
          allMethods.push(...Object.getOwnPropertyNames(proto).filter(k => {
            try { return typeof proto[k] === 'function'; } catch { return false; }
          }));
          proto = Object.getPrototypeOf(proto);
        }
        
        // Filter for action/send/request-like methods
        const actionMethods = [...new Set(allMethods)].filter(m => 
          /send|request|fetch|post|get|call|invoke|emit|dispatch|api|upload|delete|create|add|remove|block|unblock|accept|reject|forward|reply|recall/i.test(m)
        );
        
        if (actionMethods.length > 0) {
          result[name] = {
            allMethodCount: [...new Set(allMethods)].length,
            actionMethods: actionMethods.sort()
          };
        }
      }

      // Also scan $$afmc deeply for nested objects with send methods
      if (window.$$afmc) {
        const afmc = window.$$afmc;
        for (const key of Object.keys(afmc)) {
          const val = afmc[key];
          if (val && typeof val === 'object' && val !== afmc.zStorage) {
            const methods = [];
            try {
              let p = val;
              while (p && p !== Object.prototype) {
                methods.push(...Object.getOwnPropertyNames(p).filter(k => {
                  try { return typeof p[k] === 'function'; } catch { return false; }
                }));
                p = Object.getPrototypeOf(p);
              }
            } catch {}
            
            const actionMethods = [...new Set(methods)].filter(m =>
              /send|request|fetch|post|call|invoke|emit|dispatch|api/i.test(m)
            );
            
            if (actionMethods.length > 0) {
              result['$$afmc.' + key] = {
                type: val.constructor?.name || typeof val,
                actionMethods: actionMethods.sort()
              };
            }
          }
        }
      }
      
      return result;
    });
    console.log(JSON.stringify(apiObjects, null, 2));

    // ========== 3. Explore $$afmc structure deeply ==========
    console.log('\n========== $$AFMC DEEP STRUCTURE ==========');
    const afmcStructure = await zaloPage.evaluate(() => {
      const afmc = window.$$afmc;
      if (!afmc) return { error: 'No $$afmc' };
      
      const result = {};
      for (const key of Object.keys(afmc)) {
        const val = afmc[key];
        if (val === null || val === undefined) {
          result[key] = null;
          continue;
        }
        
        const info = { type: typeof val };
        if (typeof val === 'object') {
          info.constructor = val.constructor?.name;
          info.keys = Object.keys(val).slice(0, 30);
          
          // Get prototype methods
          try {
            const protoMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(val))
              .filter(m => m !== 'constructor');
            if (protoMethods.length > 0) info.protoMethods = protoMethods.slice(0, 50);
          } catch {}
          
          // Special: check for sub-objects that look like services
          for (const subKey of Object.keys(val).slice(0, 20)) {
            const subVal = val[subKey];
            if (subVal && typeof subVal === 'object' && !(subVal instanceof Array)) {
              try {
                const subMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(subVal))
                  .filter(m => m !== 'constructor' && typeof subVal[m] === 'function');
                if (subMethods.length > 5) {
                  if (!info.subServices) info.subServices = {};
                  info.subServices[subKey] = {
                    constructor: subVal.constructor?.name,
                    methods: subMethods.slice(0, 30)
                  };
                }
              } catch {}
            }
          }
        } else if (typeof val === 'function') {
          info.name = val.name;
        } else {
          info.value = String(val).slice(0, 100);
        }
        
        result[key] = info;
      }
      
      return result;
    });
    console.log(JSON.stringify(afmcStructure, null, 2));

    // ========== 4. CDP Network interception ==========
    console.log('\n========== NETWORK INTERCEPTION (WebSocket + XHR) ==========');
    console.log(`Listening for ${DURATION/1000} seconds... Perform actions in Zalo UI now.`);

    const cdpSession = await zaloPage.context().newCDPSession(zaloPage);
    
    const wsFrames = [];
    const networkRequests = [];
    
    // Enable network events
    await cdpSession.send('Network.enable');
    
    // Capture WebSocket frames
    cdpSession.on('Network.webSocketFrameSent', (params) => {
      wsFrames.push({
        direction: 'SENT',
        timestamp: Date.now(),
        requestId: params.requestId,
        data: params.response.payloadData?.slice(0, 500),
        opcode: params.response.opcode
      });
    });
    
    cdpSession.on('Network.webSocketFrameReceived', (params) => {
      wsFrames.push({
        direction: 'RECV',
        timestamp: Date.now(),
        requestId: params.requestId,
        data: params.response.payloadData?.slice(0, 500),
        opcode: params.response.opcode
      });
    });
    
    cdpSession.on('Network.webSocketCreated', (params) => {
      wsFrames.push({
        type: 'WS_CREATED',
        timestamp: Date.now(),
        requestId: params.requestId,
        url: params.url
      });
    });
    
    // Capture XHR/Fetch requests
    cdpSession.on('Network.requestWillBeSent', (params) => {
      const url = params.request.url;
      // Filter out static assets
      if (url.includes('.js') || url.includes('.css') || url.includes('.png') || 
          url.includes('.jpg') || url.includes('.ttf') || url.includes('.woff')) return;
      
      networkRequests.push({
        timestamp: Date.now(),
        method: params.request.method,
        url: url,
        type: params.type,
        postData: params.request.postData?.slice(0, 500),
        headers: Object.fromEntries(
          Object.entries(params.request.headers)
            .filter(([k]) => /content-type|authorization|cookie|x-/i.test(k))
        )
      });
    });

    // Wait for the specified duration
    await new Promise(resolve => setTimeout(resolve, DURATION));

    // Disable network
    await cdpSession.send('Network.disable');

    console.log(`\nCaptured ${wsFrames.length} WebSocket events, ${networkRequests.length} network requests`);
    
    if (wsFrames.length > 0) {
      console.log('\n--- WebSocket Events ---');
      console.log(JSON.stringify(wsFrames.slice(0, 50), null, 2));
    }
    
    if (networkRequests.length > 0) {
      console.log('\n--- Network Requests ---');
      console.log(JSON.stringify(networkRequests.slice(0, 50), null, 2));
    }

    // ========== 5. Check for WebSocket connections already active ==========
    console.log('\n========== ACTIVE WEBSOCKET INFO ==========');
    const wsInfo = await zaloPage.evaluate(() => {
      // Check if there's a reference to WebSocket instances
      const result = {};
      
      // Search for WebSocket references in known globals
      const searchObj = (obj, path, depth = 0) => {
        if (depth > 3 || !obj || typeof obj !== 'object') return;
        try {
          for (const key of Object.keys(obj).slice(0, 50)) {
            try {
              const val = obj[key];
              if (val instanceof WebSocket) {
                result[path + '.' + key] = {
                  url: val.url,
                  readyState: val.readyState,
                  protocol: val.protocol,
                  bufferedAmount: val.bufferedAmount
                };
              } else if (val && typeof val === 'object' && !(val instanceof HTMLElement) && !(val instanceof Array) && depth < 2) {
                searchObj(val, path + '.' + key, depth + 1);
              }
            } catch {}
          }
        } catch {}
      };
      
      if (window.$$afmc) searchObj(window.$$afmc, '$$afmc');
      if (window.$$AFMC_Container) {
        try {
          // Check container's internal registry
          for (const key of Object.getOwnPropertyNames(window.$$AFMC_Container)) {
            const val = window.$$AFMC_Container[key];
            if (val instanceof Map) {
              for (const [k, v] of val) {
                if (v instanceof WebSocket) {
                  result['container.' + String(k)] = {
                    url: v.url,
                    readyState: v.readyState
                  };
                } else if (v && typeof v === 'object') {
                  searchObj(v, 'container.' + String(k), 1);
                }
              }
            }
          }
        } catch {}
      }
      
      return result;
    });
    console.log(JSON.stringify(wsInfo, null, 2));

    console.log('\n========== DONE ==========');

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    if (browser) await browser.close();
  }
})();
