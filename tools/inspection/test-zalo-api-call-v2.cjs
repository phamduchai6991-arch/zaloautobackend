/**
 * test-zalo-api-call-v2.cjs
 * Try calling APIs via dThN layer which handles internal state better
 * Also try direct XHR to bypass any interceptor issues
 */

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const page = contexts[0].pages().find(p => p.url().includes('chat.zalo.me'));
  if (!page) { console.log('No Zalo page found'); process.exit(1); }

  console.log('=== TEST 1: Diagnose _request error ===');
  
  const diagResult = await page.evaluate(async () => {
    let wr;
    try {
      webpackJsonp.push([['__diag__'], {
        '__diag__': function(module, exports, require) { wr = require; }
      }, [['__diag__']]]);
    } catch(e) {}
    if (!wr) return { error: 'No webpack require' };

    const fBUP = wr('fBUP');
    const httpModule = fBUP.default || fBUP.a || fBUP;
    
    // Check if QoS service (c.default) exists
    const info = {};
    
    // Look at the _request function more carefully
    // The error is "Cannot read properties of undefined (reading 'push')"
    // at XMLHttpRequest.send - this means the XHR send has been monkey-patched
    // and something in the patch chain is broken
    
    // Check if the commandId tracker (c.default) is available
    try {
      info.requestSource = httpModule._request.toString().substring(0, 200);
    } catch(e) {
      info.requestError = e.message;
    }

    // Try to check if the QoS timer/service is initialized
    // The _request method references c.default (QoS tracker)
    // and me() function which is the actual axios/xhr caller
    
    // Instead of calling through fBUP, let's find the existing 
    // FriendListManager from the AFMC container and trigger its method
    try {
      const store = window.$$afmc?.zStorage;
      if (store) {
        // Get friends from local storage (no API call needed)
        const friends = store.getFriends ? store.getFriends() : null;
        info.localFriendCount = friends ? (Array.isArray(friends) ? friends.length : typeof friends) : 'no-method';
        
        // Try getListFriend
        const listFriend = store.getListFriend ? store.getListFriend() : null;
        info.listFriendCount = listFriend ? (Array.isArray(listFriend) ? listFriend.length : typeof listFriend) : 'no-method';
        
        // Get me/profile from storage
        const me = store.getMe ? store.getMe() : null;
        info.me = me ? { keys: Object.keys(me).slice(0, 15), name: me.displayName || me.zaloName } : null;
      }
    } catch(e) {
      info.storageError = e.message;
    }

    // Try using dThN's existing method that's known to work
    // (since the app already uses it successfully)
    try {
      const dThN = wr('dThN');
      const apiService = dThN.default;
      
      // List all methods containing 'friend' or 'online'
      const methods = Object.getOwnPropertyNames(apiService).filter(k => {
        try { return typeof apiService[k] === 'function'; } catch(e) { return false; }
      });
      const friendMethods = methods.filter(k => /friend|online/i.test(k));
      info.dThN_friendMethods = friendMethods;
      
      // Try the method that Zalo itself uses
      // FriendListManager calls apiService which calls fBUP
      // The issue might be that we're calling outside the normal event loop
    } catch(e) {
      info.dThN_error = e.message;
    }

    return info;
  });
  
  console.log(JSON.stringify(diagResult, null, 2));

  console.log('\n=== TEST 2: Try triggering via AFMC container the proper way ===');
  
  const containerResult = await page.evaluate(async () => {
    let wr;
    try {
      webpackJsonp.push([['__container__'], {
        '__container__': function(module, exports, require) { wr = require; }
      }, [['__container__']]]);
    } catch(e) {}
    if (!wr) return { error: 'No webpack require' };

    try {
      // The FriendListManager.forceRequestGetFriendList() works
      // because it goes through the proper container-resolved API service
      // Let's find it again
      const afmc = window.$$afmc;
      
      // Try to find resolved services
      const containerKeys = Object.keys(afmc || {}).filter(k => k !== 'zStorage');
      
      // The _request error at XHR.send suggests the QoS interceptor was attached
      // but its state was reset. Let's try calling through a fresh page context
      
      // Actually, let's just try a simple keepAlive call which doesn't need QoS
      const fBUP = wr('fBUP');
      const httpModule = fBUP.default;
      
      // Try calling _getCommonParams and _encodeParams (these work)
      const params = httpModule._getCommonParams();
      const encoded = httpModule._encodeParams({ test: 1 });
      
      return {
        containerKeys,
        params,
        encodedSample: encoded.substring(0, 50) + '...',
        // Check if 'me' function exists on any known module
        httpModuleKeys: Object.getOwnPropertyNames(httpModule).filter(k => 
          typeof httpModule[k] !== 'function'
        ).slice(0, 20)
      };
    } catch(e) {
      return { error: e.message, stack: e.stack?.substring(0, 300) };
    }
  });
  
  console.log(JSON.stringify(containerResult, null, 2));

  console.log('\n=== TEST 3: Intercept XHR and trigger friendList via UI action ===');

  // Set up request interception to capture the API URL and headers
  const apiCalls = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('chat.zalo.me') && url.includes('/api/')) {
      apiCalls.push({
        url: url.substring(0, 150),
        status: response.status(),
        headers: Object.fromEntries(
          Object.entries(response.headers()).filter(([k]) => 
            ['content-type', 'set-cookie'].includes(k)
          )
        )
      });
    }
  });

  // Trigger a friend list refresh by calling through the existing FriendListManager
  const triggerResult = await page.evaluate(async () => {
    // Instead of calling fBUP directly, use the XHR hook approach
    return new Promise((resolve) => {
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      const captured = [];
      
      XMLHttpRequest.prototype.open = function(method, url, ...args) {
        this._capturedUrl = url;
        this._capturedMethod = method;
        return origOpen.call(this, method, url, ...args);
      };
      
      XMLHttpRequest.prototype.send = function(body) {
        if (this._capturedUrl && this._capturedUrl.includes('/api/')) {
          captured.push({
            method: this._capturedMethod,
            url: this._capturedUrl.substring(0, 200)
          });
          
          this.addEventListener('load', function() {
            try {
              const respData = JSON.parse(this.responseText);
              captured.push({
                response: {
                  error_code: respData.error_code,
                  dataKeys: respData.data ? Object.keys(respData.data).slice(0, 10) : null,
                  dataType: respData.data ? typeof respData.data : null
                }
              });
            } catch(e) {}
          });
        }
        return origSend.call(this, body);
      };
      
      // Now trigger the action through the AFMC container
      try {
        const store = window.$$afmc?.zStorage;
        // Use the FriendListManager approach from before
        let wr;
        webpackJsonp.push([['__trigger__'], {
          '__trigger__': function(m, e, r) { wr = r; }
        }, [['__trigger__']]]);
        
        // Try calling through dThN which has proper error handling
        const dThN = wr('dThN');
        const apiService = dThN.default;
        
        // forceRequestGetFriendList triggers actual API call
        if (typeof apiService.forceRequestGetFriendList === 'function') {
          apiService.forceRequestGetFriendList();
        }
      } catch(e) {
        captured.push({ triggerError: e.message });
      }
      
      // Wait for the XHR to complete
      setTimeout(() => {
        XMLHttpRequest.prototype.open = origOpen;
        XMLHttpRequest.prototype.send = origSend;
        resolve(captured);
      }, 3000);
    });
  });
  
  console.log(JSON.stringify(triggerResult, null, 2));
  console.log('\nPlaywright captured API calls:', JSON.stringify(apiCalls, null, 2));

  await browser.close();
  console.log('\n=== DONE ===');
})();
