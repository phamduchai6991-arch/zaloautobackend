/**
 * trace-zalo-api-call.cjs
 * 
 * Hook XMLHttpRequest/fetch, trigger FriendListManager, 
 * and trace the actual API request to understand the pattern.
 * Also search deeper in webpack for API modules.
 */

const { chromium } = require('playwright');

(async () => {
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const ctx = browser.contexts()[0];
    const zaloPage = ctx.pages().find(p => p.url().includes('chat.zalo.me'));
    if (!zaloPage) { console.error('No Zalo page'); process.exit(1); }

    // 1. Hook XHR and fetch BEFORE triggering anything
    console.log('========== HOOKING XHR & FETCH ==========');
    await zaloPage.evaluate(() => {
      window.__apiTrace = [];
      
      // Hook XHR
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      
      XMLHttpRequest.prototype.open = function(method, url, ...args) {
        this.__traceUrl = url;
        this.__traceMethod = method;
        return origOpen.call(this, method, url, ...args);
      };
      
      XMLHttpRequest.prototype.send = function(body) {
        if (this.__traceUrl && !this.__traceUrl.includes('sticker') && !this.__traceUrl.includes('actionlog')) {
          window.__apiTrace.push({
            type: 'XHR',
            method: this.__traceMethod,
            url: this.__traceUrl,
            body: body ? String(body).slice(0, 500) : null,
            stack: new Error().stack.split('\n').slice(1, 8).join('\n'),
            time: Date.now()
          });
        }
        return origSend.call(this, body);
      };
      
      // Hook fetch
      const origFetch = window.fetch;
      window.fetch = function(url, opts) {
        const urlStr = typeof url === 'string' ? url : url?.url || '';
        if (urlStr && !urlStr.includes('sticker') && !urlStr.includes('actionlog')) {
          window.__apiTrace.push({
            type: 'fetch',
            url: urlStr,
            method: opts?.method || 'GET',
            body: opts?.body ? String(opts.body).slice(0, 500) : null,
            stack: new Error().stack.split('\n').slice(1, 8).join('\n'),
            time: Date.now()
          });
        }
        return origFetch.call(this, url, opts);
      };
      
      return 'Hooks installed';
    });
    console.log('XHR/Fetch hooks installed');

    // 2. Trigger FriendListManager to refresh
    console.log('\n========== TRIGGERING FRIEND LIST REFRESH ==========');
    const triggerResult = await zaloPage.evaluate(() => {
      try {
        const mgr = window.FriendListManager;
        if (!mgr) return { error: 'No FriendListManager' };
        
        // Call forceRequestGetFriendList
        const promise = mgr.forceRequestGetFriendList();
        return { triggered: true, promiseType: typeof promise };
      } catch(e) {
        return { error: e.message };
      }
    });
    console.log(JSON.stringify(triggerResult, null, 2));

    // Wait for the API call to happen
    await new Promise(r => setTimeout(r, 3000));

    // 3. Collect traces
    console.log('\n========== API TRACES ==========');
    const traces = await zaloPage.evaluate(() => window.__apiTrace || []);
    console.log(JSON.stringify(traces, null, 2));

    // 4. Try a different approach - search webpack for the module that creates API requests
    console.log('\n========== WEBPACK DEEP SEARCH ==========');
    const deepSearch = await zaloPage.evaluate(() => {
      let wr = null;
      try {
        window.webpackJsonp.push([[99994], {
          99994: function(m, e, r) { wr = r; }
        }, [[99994]]]);
        window.webpackJsonp.pop();
      } catch { return { error: 'webpack failed' }; }
      
      const result = {};
      const ids = Object.keys(wr.c);
      
      // Strategy: look for modules that export getFriendsList as a prototype method
      // or through singleton pattern
      for (const id of ids) {
        try {
          const mod = wr.c[id].exports;
          if (!mod) continue;
          
          // Check all named exports (not just default)
          for (const expKey of Object.keys(mod).slice(0, 10)) {
            const exp = mod[expKey];
            if (!exp) continue;
            
            // Check if it's a class with the right prototype
            if (typeof exp === 'function' && exp.prototype) {
              const protoNames = Object.getOwnPropertyNames(exp.prototype);
              if (protoNames.includes('getFriendsList') || protoNames.includes('sendMessage') || protoNames.includes('fetchImportantMsg')) {
                result[id + '.' + expKey] = {
                  name: exp.name,
                  type: 'class',
                  protoMethods: protoNames.filter(m => m !== 'constructor').slice(0, 60)
                };
              }
            }
            
            // Check if it's a singleton/instance
            if (typeof exp === 'object') {
              let proto = Object.getPrototypeOf(exp);
              if (proto && proto !== Object.prototype) {
                const protoNames = Object.getOwnPropertyNames(proto);
                if (protoNames.includes('getFriendsList') || protoNames.includes('sendMessage') || protoNames.includes('fetchImportantMsg')) {
                  result[id + '.' + expKey] = {
                    type: 'singleton',
                    constructor: exp.constructor?.name,
                    protoMethods: protoNames.filter(m => m !== 'constructor').slice(0, 60)
                  };
                }
              }
            }
          }
        } catch {}
      }
      
      return result;
    });
    console.log(JSON.stringify(deepSearch, null, 2));

    // 5. Search for the zpw request builder
    console.log('\n========== ZPW REQUEST BUILDER SEARCH ==========');
    const zpwSearch = await zaloPage.evaluate(() => {
      let wr = null;
      try {
        window.webpackJsonp.push([[99993], {
          99993: function(m, e, r) { wr = r; }
        }, [[99993]]]);
        window.webpackJsonp.pop();
      } catch { return { error: 'webpack failed' }; }
      
      const result = {};
      const ids = Object.keys(wr.c);
      
      for (const id of ids) {
        try {
          const mod = wr.c[id].exports;
          if (!mod) continue;
          
          for (const expKey of Object.keys(mod).slice(0, 10)) {
            const exp = mod[expKey];
            if (!exp || typeof exp !== 'function') continue;
            
            const src = exp.toString();
            // Look for functions that contain zpw_ver or wpa.chat.zalo.me
            if ((src.includes('zpw_ver') || src.includes('wpa.chat.zalo.me') || src.includes('/api/message') || src.includes('/api/friend')) && src.length < 2000) {
              result[id + '.' + expKey] = src.slice(0, 500);
            }
          }
        } catch {}
      }
      
      return result;
    });
    console.log(JSON.stringify(zpwSearch, null, 2));

    // 6. Unhook
    console.log('\n========== CLEANUP ==========');
    await zaloPage.evaluate(() => {
      delete window.__apiTrace;
      // Note: we can't easily unhook XHR/fetch but it won't cause issues
      return 'cleaned';
    });

    console.log('\n========== DONE ==========');
  } catch(err) {
    console.error('Error:', err.message);
  } finally {
    if (browser) await browser.close();
  }
})();
