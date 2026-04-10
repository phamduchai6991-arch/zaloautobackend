/**
 * test-zalo-api-call-v3.cjs
 * Deep investigation: fix the XHR.send 'push' error  
 * and find the correct way to call APIs
 */

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const page = contexts[0].pages().find(p => p.url().includes('chat.zalo.me'));
  if (!page) { console.log('No Zalo page found'); process.exit(1); }

  console.log('=== Investigate the push error in XHR.send ===');
  
  const result = await page.evaluate(async () => {
    let wr;
    try {
      webpackJsonp.push([['__v3__'], {
        '__v3__': function(module, exports, require) { wr = require; }
      }, [['__v3__']]]);
    } catch(e) {}
    if (!wr) return { error: 'No webpack require' };

    const output = {};

    // 1. Check XHR.send to see if it's been patched
    const xhrSend = XMLHttpRequest.prototype.send;
    output.xhrSendIsNative = /\[native code\]/.test(xhrSend.toString());
    output.xhrSendSource = xhrSend.toString().substring(0, 300);

    // 2. The error is in XHR.send's interceptor - let's find what's calling .push()
    // From the _request source, `me(u, g, l)` is the actual caller
    // `me` is likely an axios-like function that uses XHR
    // The QoS service (c.default) has `increaseFailed`/`increaseSuccess` 
    
    // 3. Try to trace the exact error by wrapping the call
    const fBUP = wr('fBUP');
    const httpModule = fBUP.default;
    
    try {
      // Test: can we do a simple raw XHR from this context?
      const testXhr = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', '/favicon.ico');
        xhr.onload = () => resolve({ status: xhr.status });
        xhr.onerror = (e) => reject(new Error('XHR failed: ' + e.type));
        xhr.send();
      });
      output.rawXhrWorks = testXhr;
    } catch(e) {
      output.rawXhrError = e.message;
    }

    // 4. Try using fetch instead of XHR to call the API directly
    try {
      const commonParams = httpModule._getCommonParams(); // zpw_ver=681&zpw_type=30
      const encParams = httpModule._encodeParams({
        incInvalid: 1, page: 1, count: 20, 
        avatar_size: 120, actiontime: 0,
        imei: '' // We need the actual imei/clientid
      });
      
      // We need w.a.getZaloClientID() - let's find it
      // It's likely on a utils module
      // Actually let's just get it from httpModule properties
      output.httpModuleUserId = httpModule.userId;
      output.httpModuleUIN = httpModule.UIN;
      
      // Try to get ZaloClientID from the known module
      // w.a.getZaloClientID() is from a different module
      // Let's search for it
      const z0WU = wr('z0WU');
      if (z0WU) {
        output.z0WU_keys = Object.keys(z0WU).slice(0, 10);
        if (z0WU.a && typeof z0WU.a.getZaloClientID === 'function') {
          output.zaloClientID = z0WU.a.getZaloClientID();
        } else if (z0WU.default && typeof z0WU.default.getZaloClientID === 'function') {
          output.zaloClientID = z0WU.default.getZaloClientID();
        }
      }
    } catch(e) {
      output.encError = e.message;
    }

    // 5. Find w.a (the module that has getZaloClientID)
    // Search for getZaloClientID in known modules
    const moduleIds = ['z0WU', 'jDHv', '8/YW', 'VTBJ', 'X4fA', 'XS0u', 'fsN4', 'bUXd'];
    for (const id of moduleIds) {
      try {
        const m = wr(id);
        if (!m) continue;
        const checkObj = (obj, label) => {
          if (!obj || typeof obj !== 'object') return;
          if (typeof obj.getZaloClientID === 'function') {
            output.zaloClientID_module = id;
            output.zaloClientID_export = label;
            output.zaloClientID = obj.getZaloClientID();
          }
        };
        checkObj(m, 'module');
        checkObj(m.default, 'default');
        checkObj(m.a, 'a');
        checkObj(m.b, 'b');
      } catch(e) {}
    }

    // 6. Also check if the encodeAES function we need is accessible
    try {
      const z0WU = wr('z0WU');
      if (z0WU) {
        const checkAES = (obj, label) => {
          if (!obj || typeof obj !== 'object') return;
          if (typeof obj.encodeAES === 'function') {
            output.encodeAES_module = 'z0WU';
            output.encodeAES_export = label;
            // Test it
            try {
              const encrypted = obj.encodeAES('{"test":1}');
              output.encodeAES_result = encrypted.substring(0, 50);
            } catch(e) {
              output.encodeAES_error = e.message;
            }
          }
        };
        checkAES(z0WU, 'module');
        checkAES(z0WU.default, 'default');
        checkAES(z0WU.a, 'a');
      }
    } catch(e) {}

    // 7. Try calling _request with a simpler endpoint (keepAlive)
    // The keepAlive doesn't need QoS tracking (commandId 0 skips it)
    try {
      // From the _request source: 0 !== o && c.default ? ... : me(u, g, l)
      // If commandId is 0, it skips the QoS tracking and calls me() directly
      // keepAlive uses commandId 11770 which will go through QoS
      // Let's try with commandId 0
      
      const params = httpModule._getCommonParams();
      const encData = httpModule._encodeParams({ imei: output.zaloClientID || '' });
      
      // Call _get with commandId 0 to bypass QoS
      const keepAliveUrl = `https://tt-chat-wpa.chat.zalo.me/keepalive?${params}&params=${encData}`;
      
      // Use _request directly with commandId 0
      const response = await httpModule._request(true, keepAliveUrl, null, { timeout: 5000 }, 0, 0, false, null);
      output.keepAliveResponse = {
        status: response?.status,
        data: response?.data ? JSON.stringify(response.data).substring(0, 200) : null
      };
    } catch(e) {
      output.keepAliveError = e.message;
      output.keepAliveStack = e.stack?.substring(0, 500);
    }

    return output;
  });
  
  console.log(JSON.stringify(result, null, 2));

  await browser.close();
  console.log('\n=== DONE ===');
})();
