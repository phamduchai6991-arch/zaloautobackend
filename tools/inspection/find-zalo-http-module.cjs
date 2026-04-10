/**
 * find-zalo-http-module.cjs
 * 
 * Find the r.default HTTP module used by dThN for API calls.
 * Search by prototype chain and method source patterns.
 */

const { chromium } = require('playwright');

(async () => {
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const ctx = browser.contexts()[0];
    const zaloPage = ctx.pages().find(p => p.url().includes('chat.zalo.me'));
    if (!zaloPage) { console.error('No Zalo page'); process.exit(1); }

    // Strategy 1: Search for module with sendFriendRequest on its prototype chain
    console.log('========== PROTOTYPE CHAIN SEARCH ==========');
    const protoSearch = await zaloPage.evaluate(() => {
      let wr = null;
      try {
        window.webpackJsonp.push([[99988], {
          99988: function(m, e, r) { wr = r; }
        }, [[99988]]]);
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
            if (!exp) continue;
            
            // Search prototype chain
            let proto = typeof exp === 'object' ? Object.getPrototypeOf(exp) : 
                        typeof exp === 'function' ? exp.prototype : null;
            
            if (proto && proto !== Object.prototype && proto !== Function.prototype) {
              try {
                const protoNames = Object.getOwnPropertyNames(proto);
                if (protoNames.includes('sendFriendRequest')) {
                  result[id + '.' + expKey] = {
                    type: typeof exp,
                    constructor: exp.constructor?.name || (typeof exp === 'function' ? exp.name : ''),
                    protoMethods: protoNames.filter(m => m !== 'constructor').slice(0, 80),
                  };
                  
                  // Get key method sources
                  result[id + '.' + expKey + '_sigs'] = {};
                  for (const m of ['sendFriendRequest', 'request', '_request', 'sendMsg', 'sendMessage', 'getFriendsList']) {
                    if (typeof (exp[m] || proto[m]) === 'function') {
                      result[id + '.' + expKey + '_sigs'][m] = (exp[m] || proto[m]).toString().slice(0, 600);
                    }
                  }
                }
              } catch {}
            }
          }
        } catch {}
      }
      
      return result;
    });
    console.log(JSON.stringify(protoSearch, null, 2));

    // Strategy 2: Use the dThN module's imports directly
    console.log('\n========== dThN MODULE IMPORT TRACE ==========');
    const importTrace = await zaloPage.evaluate(() => {
      let wr = null;
      try {
        window.webpackJsonp.push([[99987], {
          99987: function(m, e, r) { wr = r; }
        }, [[99987]]]);
        window.webpackJsonp.pop();
      } catch { return { error: 'webpack failed' }; }
      
      // Get the dThN module source to find what 'r' is imported from
      const mod = wr.c['dThN'];
      if (!mod) return { error: 'No dThN module in cache' };
      
      // The module factory function should be available
      const result = {};
      
      // Get the module's source
      // In webpack, modules are stored as functions in the chunks
      // Let's find the module factory
      for (const chunk of window.webpackJsonp) {
        if (chunk[1] && chunk[1]['dThN']) {
          result.factorySource = chunk[1]['dThN'].toString().slice(0, 2000);
          break;
        }
      }
      
      return result;
    });
    console.log(JSON.stringify(importTrace, null, 2));

    // Strategy 3: Search modules that export request/_request methods with zpw pattern
    console.log('\n========== REQUEST MODULE SEARCH ==========');
    const reqSearch = await zaloPage.evaluate(() => {
      let wr = null;
      try {
        window.webpackJsonp.push([[99986], {
          99986: function(m, e, r) { wr = r; }
        }, [[99986]]]);
        window.webpackJsonp.pop();
      } catch { return { error: 'webpack failed' }; }
      
      const result = {};
      const ids = Object.keys(wr.c);
      let checked = 0;
      
      for (const id of ids) {
        if (checked++ > 500) break;
        try {
          const mod = wr.c[id].exports;
          if (!mod) continue;
          
          for (const expKey of Object.keys(mod).slice(0, 5)) {
            const exp = mod[expKey];
            if (!exp || typeof exp !== 'object') continue;
            
            // Check if it has both request and sendFriendRequest (even deeply)
            if (typeof exp.sendFriendRequest !== 'function') continue;
            if (typeof exp.request !== 'function' && typeof exp._request !== 'function') continue;
            
            result[id + '.' + expKey] = {
              constructor: exp.constructor?.name,
              hasSendFriendRequest: true,
              hasRequest: typeof exp.request === 'function',
              has_request: typeof exp._request === 'function',
              methods: []
            };
            
            // Get ALL methods from prototype chain
            let proto = exp;
            while (proto && proto !== Object.prototype) {
              try {
                result[id + '.' + expKey].methods.push(
                  ...Object.getOwnPropertyNames(proto)
                    .filter(m => { try { return typeof proto[m] === 'function' && m !== 'constructor'; } catch { return false; } })
                );
              } catch {}
              proto = Object.getPrototypeOf(proto);
            }
            result[id + '.' + expKey].methods = [...new Set(result[id + '.' + expKey].methods)].slice(0, 100);
            
            // Get request/_request source
            if (typeof exp.request === 'function') {
              result[id + '.' + expKey + '_request_src'] = exp.request.toString().slice(0, 800);
            }
            if (typeof exp._request === 'function') {
              result[id + '.' + expKey + '__request_src'] = exp._request.toString().slice(0, 800);
            }
            if (typeof exp.sendFriendRequest === 'function') {
              result[id + '.' + expKey + '_sendFriendReq_src'] = exp.sendFriendRequest.toString().slice(0, 600);
            }
            
            // Store for later
            window.__zaloHttpApi = exp;
          }
        } catch {}
      }
      
      return result;
    });
    console.log(JSON.stringify(reqSearch, null, 2));

    console.log('\n========== DONE ==========');
  } catch(err) {
    console.error('Error:', err.message);
  } finally {
    if (browser) await browser.close();
  }
})();
