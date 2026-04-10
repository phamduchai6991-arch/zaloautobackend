/**
 * Deep exploration of Zalo internals after login.
 * Connects to the browser launched by launch-zalo-browser.cjs (port 9222)
 * and extracts: cookies, zStorage methods, API patterns, friend list shape,
 * conversation structure, and attempts to discover action APIs.
 *
 * Usage: node tools/inspection/explore-zalo-session.cjs
 */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const pages = context.pages();
  const page = pages.find(p => p.url().includes('chat.zalo.me'));
  if (!page) { console.error('No chat.zalo.me tab found'); process.exit(1); }

  console.log('Connected to:', page.url());

  // ===== 1. COOKIES =====
  const cookies = await context.cookies('https://chat.zalo.me');
  console.log(`\n========== COOKIES (${cookies.length}) ==========`);
  cookies.forEach(c => {
    console.log(`  ${c.name} = ${String(c.value).substring(0, 60)}${c.value.length > 60 ? '...' : ''}`);
    console.log(`    domain=${c.domain} httpOnly=${c.httpOnly} secure=${c.secure} sameSite=${c.sameSite}`);
  });

  // ===== 2. SESSION STATE =====
  const sessionState = await page.evaluate(() => {
    const r = {};
    r.url = location.href;
    r.title = document.title;
    r.hasAfmc = typeof window.$$afmc !== 'undefined';
    r.hasZStorage = !!(window.$$afmc && window.$$afmc.zStorage);
    r.hasAfmcContainer = typeof window.$$AFMC_Container !== 'undefined';
    
    // Check for other interesting globals
    const interesting = [];
    for (const key of Object.getOwnPropertyNames(window)) {
      try {
        const val = window[key];
        if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof HTMLElement) && !(val instanceof Event)) {
          const keys = Object.keys(val);
          if (keys.length > 0 && keys.length < 100) {
            const kl = key.toLowerCase();
            if (kl.includes('zalo') || kl.includes('zpw') || kl.includes('afmc') || kl.includes('friend') || 
                kl.includes('contact') || kl.includes('chat') || kl.includes('msg') || kl.includes('store') ||
                kl.includes('module') || kl.includes('api') || kl.includes('service') || kl.includes('manager') ||
                kl.startsWith('$$') || kl.startsWith('__')) {
              interesting.push({ name: key, keyCount: keys.length, sampleKeys: keys.slice(0, 8) });
            }
          }
        }
      } catch(e) {}
    }
    r.interestingGlobals = interesting;
    return r;
  });
  console.log('\n========== SESSION STATE ==========');
  console.log(JSON.stringify(sessionState, null, 2));

  // ===== 3. zStorage METHODS =====
  if (sessionState.hasZStorage) {
    const zsMethods = await page.evaluate(() => {
      const zs = window.$$afmc.zStorage;
      const proto = Object.getPrototypeOf(zs);
      const methods = Object.getOwnPropertyNames(proto).filter(k => typeof proto[k] === 'function').sort();
      // Categorize
      const categories = {
        friend: methods.filter(m => /friend|contact|phone|block/i.test(m)),
        group: methods.filter(m => /group|member/i.test(m)),
        message: methods.filter(m => /msg|message|chat|conv|send/i.test(m)),
        account: methods.filter(m => /account|profile|user|login|auth/i.test(m)),
        data: methods.filter(m => /get|find|list|search|load|fetch|query/i.test(m)),
        action: methods.filter(m => /send|add|remove|delete|update|set|create|invite|kick|block|unblock|accept|reject|request|join|leave/i.test(m)),
      };
      return { total: methods.length, all: methods, categories };
    });
    console.log(`\n========== zStorage METHODS (${zsMethods.total}) ==========`);
    console.log('\n--- Friend-related ---');
    console.log(zsMethods.categories.friend.join(', '));
    console.log('\n--- Group-related ---');
    console.log(zsMethods.categories.group.join(', '));
    console.log('\n--- Message-related ---');
    console.log(zsMethods.categories.message.join(', '));
    console.log('\n--- Account-related ---');
    console.log(zsMethods.categories.account.join(', '));
    console.log('\n--- Action methods (send/add/remove/create etc) ---');
    console.log(zsMethods.categories.action.join(', '));
    console.log('\n--- ALL methods ---');
    console.log(zsMethods.all.join(', '));

    // ===== 4. FRIEND LIST SAMPLE =====
    const friendSample = await page.evaluate(async () => {
      try {
        const zs = window.$$afmc.zStorage;
        const friends = await zs.getFriends();
        if (!friends) return { error: 'null' };
        const arr = Array.isArray(friends) ? friends : (friends instanceof Map ? [...friends.values()] : Object.values(friends));
        return {
          count: arr.length,
          sampleKeys: arr.length > 0 ? Object.keys(arr[0]) : [],
          sample: arr.slice(0, 2).map(f => {
            const o = {};
            for (const [k, v] of Object.entries(f)) {
              if (typeof v === 'string') o[k] = v.substring(0, 80);
              else if (typeof v === 'number' || typeof v === 'boolean' || v === null) o[k] = v;
              else o[k] = `[${typeof v}]`;
            }
            return o;
          }),
        };
      } catch(e) { return { error: e.message }; }
    });
    console.log('\n========== FRIENDS SAMPLE ==========');
    console.log(JSON.stringify(friendSample, null, 2));

    // ===== 5. CONVERSATION SAMPLE =====
    const convSample = await page.evaluate(async () => {
      try {
        const zs = window.$$afmc.zStorage;
        // Try getConversations
        let convs;
        if (typeof zs.getConversations === 'function') convs = await zs.getConversations();
        else if (typeof zs.getConvs === 'function') convs = await zs.getConvs();
        if (!convs) return { error: 'no conversations method found or null result' };
        const arr = Array.isArray(convs) ? convs : (convs instanceof Map ? [...convs.values()] : Object.values(convs));
        return {
          count: arr.length,
          sampleKeys: arr.length > 0 ? Object.keys(arr[0]) : [],
          sample: arr.slice(0, 2).map(c => {
            const o = {};
            for (const [k, v] of Object.entries(c)) {
              if (typeof v === 'string') o[k] = v.substring(0, 80);
              else if (typeof v === 'number' || typeof v === 'boolean' || v === null) o[k] = v;
              else if (Array.isArray(v)) o[k] = `Array[${v.length}]`;
              else o[k] = `[${typeof v}]`;
            }
            return o;
          }),
        };
      } catch(e) { return { error: e.message }; }
    });
    console.log('\n========== CONVERSATIONS SAMPLE ==========');
    console.log(JSON.stringify(convSample, null, 2));

    // ===== 6. EXPLORE $$AFMC_Container =====
    const containerInfo = await page.evaluate(() => {
      try {
        const c = window.$$AFMC_Container;
        if (!c) return 'not found';
        const info = { keys: Object.keys(c) };
        if (c._registry && c._registry instanceof Map) {
          info.registryKeys = [...c._registry.keys()].map(String).slice(0, 60);
        } else if (c._registry) {
          info.registryKeys = Object.keys(c._registry).slice(0, 60);
        }
        // Try to find service locator patterns
        if (typeof c.resolve === 'function') {
          info.hasResolve = true;
        }
        if (typeof c.get === 'function') {
          info.hasGet = true;
        }
        return info;
      } catch(e) { return { error: e.message }; }
    });
    console.log('\n========== $$AFMC_Container ==========');
    console.log(JSON.stringify(containerInfo, null, 2));

    // ===== 7. NETWORK INTERCEPT SETUP INFO =====
    // Check for fetch/XHR patterns in the page 
    const apiPatterns = await page.evaluate(() => {
      // Look at performance entries for API calls
      const entries = performance.getEntriesByType('resource');
      const apiCalls = entries
        .filter(e => e.name.includes('/api/') || e.name.includes('wpa/') || e.name.includes('zpw') || 
                     e.name.includes('client/') || e.name.includes('zalo'))
        .map(e => ({ url: e.name.substring(0, 150), type: e.initiatorType, duration: Math.round(e.duration) }));
      return { total: entries.length, apiRelated: apiCalls.slice(0, 30) };
    });
    console.log('\n========== API PATTERNS (from performance entries) ==========');
    console.log(JSON.stringify(apiPatterns, null, 2));
  }

  // ===== 8. Try to discover action modules =====
  const actionDiscovery = await page.evaluate(() => {
    const results = {};
    
    // Look for any send-message related functions
    const zs = window.$$afmc?.zStorage;
    if (zs) {
      const proto = Object.getPrototypeOf(zs);
      // Try to find sendMessage signature
      const sendMethods = Object.getOwnPropertyNames(proto).filter(m => 
        /send|addFriend|requestFriend|removeFriend|unfriend|blockFriend/i.test(m)
      );
      results.sendMethods = sendMethods;
      
      // Try to get function signatures by converting to string
      sendMethods.forEach(m => {
        try {
          const fn = proto[m];
          const src = fn.toString().substring(0, 300);
          results[`${m}_signature`] = src;
        } catch(e) {}
      });
    }
    
    // Look for React fiber store with dispatch
    const rootEl = document.getElementById('root') || document.getElementById('app');
    if (rootEl) {
      const fiberKey = Object.keys(rootEl).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      results.reactFiberFound = !!fiberKey;
    }
    
    return results;
  });
  console.log('\n========== ACTION METHOD DISCOVERY ==========');
  console.log(JSON.stringify(actionDiscovery, null, 2));

  console.log('\n========== DONE ==========');
  await browser.close();
})();
