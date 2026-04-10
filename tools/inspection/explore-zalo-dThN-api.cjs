/**
 * explore-zalo-dThN-api.cjs
 * 
 * Deep exploration of the main API service module (dThN.default):
 * - Method signatures for all API methods
 * - Credentials & encryption pattern
 * - Request builder internals
 */

const { chromium } = require('playwright');

(async () => {
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const ctx = browser.contexts()[0];
    const zaloPage = ctx.pages().find(p => p.url().includes('chat.zalo.me'));
    if (!zaloPage) { console.error('No Zalo page'); process.exit(1); }

    // 1. Get dThN module and all method signatures
    console.log('========== dThN API SERVICE - KEY METHODS ==========');
    const apiSvc = await zaloPage.evaluate(() => {
      let wr = null;
      try {
        window.webpackJsonp.push([[99992], {
          99992: function(m, e, r) { wr = r; }
        }, [[99992]]]);
        window.webpackJsonp.pop();
      } catch { return { error: 'webpack failed' }; }
      
      const mod = wr('dThN');
      const svc = mod.default;
      if (!svc) return { error: 'No dThN.default' };
      
      // Store reference for later use
      window.__zaloApiService = svc;
      
      const result = {};
      
      // Get credentials info
      result.ownKeys = Object.keys(svc);
      result.constructor = svc.constructor?.name;
      
      // Get credential-related properties
      for (const key of Object.keys(svc)) {
        const val = svc[key];
        if (typeof val === 'string') {
          result['prop_' + key] = val.length > 200 ? val.slice(0, 100) + '...[' + val.length + ' chars]' : val;
        } else if (typeof val === 'number' || typeof val === 'boolean') {
          result['prop_' + key] = val;
        } else if (typeof val === 'object' && val !== null) {
          result['prop_' + key] = { type: typeof val, constructor: val.constructor?.name, keys: Object.keys(val).slice(0, 10) };
        }
      }
      
      return result;
    });
    console.log(JSON.stringify(apiSvc, null, 2));

    // 2. Get key method signatures
    console.log('\n========== KEY METHOD SIGNATURES ==========');
    const methods = await zaloPage.evaluate(() => {
      const svc = window.__zaloApiService;
      if (!svc) return { error: 'No svc' };
      
      const result = {};
      const keyMethods = [
        'setCredentials', 'doGET', 'storage',
        'sendFriendRequest', 'acceptFriendRequest', 'rejectFriendRequest',
        'removeFriend', 'blockMember', 'unblockMember',
        'fetchFriendsByIds', 'fetchFriendsByIdsV2',
        'createGroup', 'addMemberToGroup', 'removeMemberFromGroup',
        'leaveGroup', 'changeGroupName',
        'updateAlias', 'removeAlias',
        'getFriendRequestStatus', 'getRecommendedFriends', 'getRequestedFriends',
        'getFriendOnlines', 'fetchProfileByUsername',
        'searchSticker', 'getListBank',
        'downloadFilesByXHR', 'updateLanguage'
      ];
      
      for (const m of keyMethods) {
        try {
          const fn = svc[m];
          if (typeof fn === 'function') {
            result[m] = fn.toString().slice(0, 800);
          } else if (fn !== undefined) {
            result[m] = { type: typeof fn, value: String(fn).slice(0, 200) };
          }
        } catch(e) { result[m] = { error: e.message }; }
      }
      
      return result;
    });
    console.log(JSON.stringify(methods, null, 2));

    // 3. Get request/doGET internals
    console.log('\n========== REQUEST BUILDER INTERNALS ==========');
    const reqBuilder = await zaloPage.evaluate(() => {
      const svc = window.__zaloApiService;
      if (!svc) return { error: 'No svc' };
      
      const result = {};
      
      // Get the prototype chain to find _request, request, doGET originals
      let proto = Object.getPrototypeOf(svc);
      const protoMethods = [];
      while (proto && proto !== Object.prototype) {
        protoMethods.push(...Object.getOwnPropertyNames(proto).filter(m => m !== 'constructor'));
        proto = Object.getPrototypeOf(proto);
      }
      result.allProtoMethods = [...new Set(protoMethods)];
      
      // Get the base request methods
      const baseMethods = ['request', '_request', 'get', 'post', 'doGET', 'doPOST',
                           '_buildUrl', '_buildParams', '_encrypt', '_decrypt', '_encryptParams',
                           'encryptRequest', 'decryptResponse'];
      for (const m of baseMethods) {
        try {
          if (typeof svc[m] === 'function') {
            result[m + '_src'] = svc[m].toString().slice(0, 800);
          }
        } catch {}
      }
      
      return result;
    });
    console.log(JSON.stringify(reqBuilder, null, 2));

    // 4. Find how sendFriendRequest actually works
    console.log('\n========== SEND FRIEND REQUEST DEEP ==========');
    const friendReq = await zaloPage.evaluate(() => {
      const svc = window.__zaloApiService;
      if (!svc) return { error: 'No svc' };
      
      // Get full source of sendFriendRequest and related methods
      const result = {};
      
      try { result.sendFriendRequest = svc.sendFriendRequest.toString(); } catch {}
      try { result.acceptFriendRequest = svc.acceptFriendRequest.toString(); } catch {}
      try { result.rejectFriendRequest = svc.rejectFriendRequest.toString(); } catch {}
      try { result.removeFriend = svc.removeFriend.toString(); } catch {}
      try { result.blockMember = svc.blockMember.toString(); } catch {}
      try { result.unblockMember = svc.unblockMember.toString(); } catch {}
      try { result.createGroup = svc.createGroup.toString().slice(0, 1000); } catch {}
      try { result.addMemberToGroup = svc.addMemberToGroup.toString(); } catch {}
      
      return result;
    });
    console.log(JSON.stringify(friendReq, null, 2));

    // 5. Find where sendMessage lives (not in dThN, likely in another module)
    console.log('\n========== FIND SEND MESSAGE MODULE ==========');
    const sendMsg = await zaloPage.evaluate(() => {
      let wr = null;
      try {
        window.webpackJsonp.push([[99991], {
          99991: function(m, e, r) { wr = r; }
        }, [[99991]]]);
        window.webpackJsonp.pop();
      } catch { return { error: 'webpack failed' }; }
      
      const result = {};
      const ids = Object.keys(wr.c);
      
      // Search for sendMessage on prototypes/singletons
      for (const id of ids) {
        try {
          const mod = wr.c[id].exports;
          if (!mod) continue;
          
          for (const expKey of Object.keys(mod).slice(0, 10)) {
            const exp = mod[expKey];
            if (!exp) continue;
            
            // Check prototype
            if (typeof exp === 'function' && exp.prototype) {
              const pn = Object.getOwnPropertyNames(exp.prototype);
              if (pn.includes('sendMessage') && !pn.includes('render')) {
                // Skip React components - we want the service, not UI
                result[id + '.' + expKey] = {
                  type: 'class',
                  name: exp.name,
                  methods: pn.filter(m => m !== 'constructor').slice(0, 40),
                  sendMessageSrc: exp.prototype.sendMessage.toString().slice(0, 600)
                };
              }
            }
            
            // Check instance
            if (typeof exp === 'object') {
              let proto = Object.getPrototypeOf(exp);
              if (proto && proto !== Object.prototype) {
                const pn = Object.getOwnPropertyNames(proto);
                if (pn.includes('sendMessage') && !pn.includes('render')) {
                  result[id + '.' + expKey] = {
                    type: 'singleton',
                    constructor: exp.constructor?.name,
                    methods: pn.filter(m => m !== 'constructor').slice(0, 40),
                    sendMessageSrc: exp.sendMessage.toString().slice(0, 600)
                  };
                }
              }
            }
          }
        } catch {}
      }
      
      return result;
    });
    console.log(JSON.stringify(sendMsg, null, 2));

    console.log('\n========== DONE ==========');
  } catch(err) {
    console.error('Error:', err.message);
  } finally {
    if (browser) await browser.close();
  }
})();
