/**
 * explore-zalo-webpack-api.cjs
 * 
 * Find API modules in webpack cache for:
 * - getFriendsList, sendMessage, addFriend, etc.
 * Uses targeted search to avoid memory issues.
 */

const { chromium } = require('playwright');

(async () => {
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const ctx = browser.contexts()[0];
    const zaloPage = ctx.pages().find(p => p.url().includes('chat.zalo.me'));
    if (!zaloPage) { console.error('No Zalo page'); process.exit(1); }

    // 1. Get webpack require and find specific API modules
    console.log('========== WEBPACK API MODULE HUNT ==========');
    const apiHunt = await zaloPage.evaluate(() => {
      const result = {};
      
      // Get webpack require
      let wr = null;
      try {
        window.webpackJsonp.push([[99997], {
          99997: function(m, e, r) { wr = r; }
        }, [[99997]]]);
        window.webpackJsonp.pop();
      } catch(e) { return { error: 'webpack trick failed: ' + e.message }; }
      
      if (!wr || !wr.c) return { error: 'No webpack require or cache' };
      
      result.totalModules = Object.keys(wr.c).length;
      
      // Search specifically for modules with getFriendsList
      const ids = Object.keys(wr.c);
      
      // Search for key method names
      const searches = {
        getFriendsList: [],
        sendMessage: [],
        sendMsg: [],
        addFriend: [],
        sendFriendRequest: [],
        unfriend: [],
        blockFriend: [],
        fetchImportantMsg: [],
        sendTextMessage: [],
        createGroup: [],
      };
      
      for (const id of ids) {
        try {
          const mod = wr.c[id];
          if (!mod?.exports) continue;
          
          // Check default export and direct exports
          const targets = [mod.exports, mod.exports.default].filter(Boolean);
          
          for (const exp of targets) {
            if (typeof exp !== 'object' && typeof exp !== 'function') continue;
            
            const keys = typeof exp === 'function' ? 
              Object.getOwnPropertyNames(exp.prototype || {}) :
              Object.keys(exp);
            
            for (const searchKey of Object.keys(searches)) {
              if (keys.includes(searchKey)) {
                searches[searchKey].push(id);
              }
            }
          }
        } catch {}
      }
      
      result.modulesByMethod = searches;
      return result;
    });
    console.log(JSON.stringify(apiHunt, null, 2));

    // 2. For found modules, get their method listings
    console.log('\n========== MODULE DETAILS ==========');
    const allFoundIds = new Set();
    if (apiHunt.modulesByMethod) {
      for (const ids of Object.values(apiHunt.modulesByMethod)) {
        for (const id of ids) allFoundIds.add(id);
      }
    }
    
    if (allFoundIds.size > 0) {
      const details = await zaloPage.evaluate((moduleIds) => {
        let wr = null;
        try {
          window.webpackJsonp.push([[99996], {
            99996: function(m, e, r) { wr = r; }
          }, [[99996]]]);
          window.webpackJsonp.pop();
        } catch { return { error: 'webpack failed' }; }
        
        const result = {};
        for (const id of moduleIds) {
          try {
            const mod = wr(id);
            const exp = mod.default || mod;
            
            if (typeof exp === 'object') {
              const methods = Object.keys(exp).filter(k => typeof exp[k] === 'function');
              result[id] = { type: 'object', methods: methods.slice(0, 80) };
              
              // Get signatures of key methods
              const sigs = {};
              for (const m of methods) {
                if (/send|get.*Friend|add.*Friend|block|unfriend|stranger|message|create.*Group|delete|forward|reply|accept|reject/i.test(m)) {
                  try { sigs[m] = exp[m].toString().slice(0, 400); } catch {}
                }
              }
              result[id].signatures = sigs;
            } else if (typeof exp === 'function') {
              result[id] = { type: 'function', name: exp.name };
              const proto = exp.prototype;
              if (proto) {
                const methods = Object.getOwnPropertyNames(proto).filter(m => m !== 'constructor');
                result[id].protoMethods = methods.slice(0, 40);
              }
            }
          } catch(e) { result[id] = { error: e.message }; }
        }
        return result;
      }, [...allFoundIds]);
      console.log(JSON.stringify(details, null, 2));
    }

    // 3. Also search by scanning function source for zpw_ver or api URL patterns
    console.log('\n========== API URL PATTERN SEARCH ==========');
    const urlSearch = await zaloPage.evaluate(() => {
      let wr = null;
      try {
        window.webpackJsonp.push([[99995], {
          99995: function(m, e, r) { wr = r; }
        }, [[99995]]]);
        window.webpackJsonp.pop();
      } catch { return { error: 'webpack failed' }; }
      
      const result = {};
      const ids = Object.keys(wr.c);
      let scanned = 0;
      
      for (const id of ids) {
        try {
          const mod = wr.c[id];
          if (!mod?.exports) continue;
          
          const exp = mod.exports.default || mod.exports;
          if (typeof exp !== 'object' || exp === null) continue;
          
          const keys = Object.keys(exp);
          for (const k of keys.slice(0, 30)) {
            try {
              if (typeof exp[k] !== 'function') continue;
              const src = exp[k].toString();
              
              // Look for API URL construction patterns
              if (src.includes('wpa.chat.zalo.me') || 
                  src.includes('/api/') && src.includes('zpw_ver') ||
                  src.includes('sendMessage') && src.includes('fetch')) {
                if (!result[id]) result[id] = {};
                result[id][k] = src.slice(0, 300);
              }
            } catch {}
          }
          
          scanned++;
          if (scanned > 500) break; // Safety limit
        } catch {}
      }
      
      result._scanned = scanned;
      return result;
    });
    console.log(JSON.stringify(urlSearch, null, 2));

    console.log('\n========== DONE ==========');
  } catch(err) {
    console.error('Error:', err.message);
  } finally {
    if (browser) await browser.close();
  }
})();
