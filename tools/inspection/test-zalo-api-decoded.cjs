/**
 * test-zalo-api-decoded.cjs
 * Call APIs and decode the AES-encrypted responses
 */

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const page = contexts[0].pages().find(p => p.url().includes('chat.zalo.me'));
  if (!page) { console.log('No Zalo page found'); process.exit(1); }

  // Ensure XHR is fixed
  await page.evaluate(() => { if (!window.__apiTrace) window.__apiTrace = []; });

  const result = await page.evaluate(async () => {
    let wr;
    try {
      webpackJsonp.push([['__decoded__'], {
        '__decoded__': function(module, exports, require) { wr = require; }
      }, [['__decoded__']]]);
    } catch(e) {}
    if (!wr) return { error: 'No webpack require' };

    const fBUP = wr('fBUP');
    const httpModule = fBUP.default;
    
    // Find decodeAES - it's i.default.decodeAES() inside fBUP
    // i is from the module scope of fBUP - let's find it
    // From the factory, i = require("z0WU") but z0WU doesn't have it
    // Let's search for decodeAES
    let decodeAES = null;
    const moduleIds = ['z0WU', 'jDHv', '8/YW', 'VTBJ', 'X4fA', 'XS0u', 'fsN4', 'bUXd'];
    for (const id of moduleIds) {
      try {
        const m = wr(id);
        if (!m) continue;
        for (const key of ['default', 'a', 'b', '']) {
          const obj = key ? m[key] : m;
          if (obj && typeof obj.decodeAES === 'function') {
            decodeAES = obj.decodeAES.bind(obj);
            break;
          }
        }
        if (decodeAES) break;
      } catch(e) {}
    }

    // If not found, try broader search  
    if (!decodeAES) {
      // The httpModule uses i.default.encodeAES internally
      // Let's check if encryptParam/decryptResp on httpModule uses it
      if (typeof httpModule.decryptResp === 'function') {
        // Get its source
        const src = httpModule.decryptResp.toString();
        return { decryptRespSource: src.substring(0, 500), noDecodeAES: true };
      }
      
      // Try to find it by checking the module that provides encodeAES
      // The _encodeParams uses i.default.encodeAES - that 'i' is in module scope
      // We can get it by finding which module the fBUP factory imports
      // We already know fBUP's factory source has: var i = a("jDHv")
      // Wait no, from dThN we saw: var l = a("z0WU") for utils  
      // But from fBUP source: i.default.encodeAES
      // Let's try all modules more broadly
      
      const cache = wr.c || {};
      let found = false;
      for (const key in cache) {
        if (found) break;
        try {
          const mod = cache[key];
          if (!mod || !mod.exports) continue;
          const exp = mod.exports;
          for (const ek of ['default', 'a', 'b', '']) {
            const obj = ek ? exp[ek] : exp;
            if (obj && typeof obj === 'object' && typeof obj.decodeAES === 'function') {
              decodeAES = obj.decodeAES.bind(obj);
              found = true;
              break;
            }
          }
        } catch(e) {}
      }
    }

    if (!decodeAES) {
      return { error: 'Could not find decodeAES function' };
    }

    const output = {};

    // 1. Get friends list and decode
    try {
      const response = await httpModule.getFriendsList(0);
      if (response?.data?.data && typeof response.data.data === 'string') {
        const decoded = decodeAES(response.data.data);
        const parsed = JSON.parse(decoded);
        output.friendsList = {
          errorCode: response.data.error_code,
          totalFriends: Array.isArray(parsed) ? parsed.length : typeof parsed,
          sample: Array.isArray(parsed) && parsed[0] ? {
            keys: Object.keys(parsed[0]).slice(0, 20),
            userId: parsed[0].userId,
            displayName: parsed[0].displayName || parsed[0].zaloName,
            avatar: parsed[0].avatar ? 'has' : 'none'
          } : parsed
        };
      } else {
        output.friendsList = { raw: JSON.stringify(response?.data).substring(0, 500) };
      }
    } catch(e) {
      output.friendsListError = e.message;
    }

    // 2. Get profile and decode
    try {
      const response = await httpModule.getProfileMeV2();  
      if (response?.data?.data && typeof response.data.data === 'string') {
        const decoded = decodeAES(response.data.data);
        const parsed = JSON.parse(decoded);
        output.profile = {
          errorCode: response.data.error_code,
          keys: Object.keys(parsed).slice(0, 25),
          displayName: parsed.displayName || parsed.zaloName,
          userId: parsed.userId,
          phoneNumber: parsed.phoneNumber ? '***hidden***' : 'not-present'
        };
      } else {
        output.profile = { raw: JSON.stringify(response?.data).substring(0, 500) };
      }
    } catch(e) {
      output.profileError = e.message;
    }

    // 3. Get online friends and decode
    try {
      const response = await httpModule.requestGetFriendOnlines();
      if (response?.data?.data && typeof response.data.data === 'string') {
        const decoded = decodeAES(response.data.data);
        const parsed = JSON.parse(decoded);
        output.onlineFriends = {
          count: Array.isArray(parsed) ? parsed.length : typeof parsed,
          sample: Array.isArray(parsed) ? parsed.slice(0, 3) : parsed
        };
      } else {
        output.onlineFriends = { data: response?.data };
      }
    } catch(e) {
      output.onlineFriendsError = e.message;
    }

    // 4. Get group list
    try {
      const response = await httpModule.getGroupListV4(0);
      if (response?.data?.data && typeof response.data.data === 'string') {
        const decoded = decodeAES(response.data.data);
        const parsed = JSON.parse(decoded);
        output.groups = {
          count: Array.isArray(parsed) ? parsed.length : typeof parsed,
          sample: Array.isArray(parsed) && parsed[0] ? {
            keys: Object.keys(parsed[0]).slice(0, 15),
            name: parsed[0].name,
            groupId: parsed[0].groupId || parsed[0].gridTo
          } : null
        };
      }
    } catch(e) {
      output.groupsError = e.message;
    }

    // 5. Get pinned conversations
    try {
      const response = await httpModule.getPinnedConversations();
      if (response?.data) {
        output.pinned = {
          errorCode: response.data.error_code,
          data: typeof response.data.data === 'string' 
            ? JSON.parse(decodeAES(response.data.data))
            : response.data.data
        };
      }
    } catch(e) {
      output.pinnedError = e.message;
    }

    return output;
  });

  console.log(JSON.stringify(result, null, 2));

  await browser.close();
  console.log('\n=== DONE ===');
})();
