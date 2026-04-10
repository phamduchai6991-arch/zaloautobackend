/**
 * explore-zalo-fBUP-http.cjs
 * 
 * Deep dive into fBUP module (the core HTTP API transport layer).
 */

const { chromium } = require('playwright');

(async () => {
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const ctx = browser.contexts()[0];
    const zaloPage = ctx.pages().find(p => p.url().includes('chat.zalo.me'));
    if (!zaloPage) { console.error('No Zalo page'); process.exit(1); }

    // 1. Get fBUP module
    console.log('========== fBUP MODULE STRUCTURE ==========');
    const fBUP = await zaloPage.evaluate(() => {
      let wr = null;
      try {
        window.webpackJsonp.push([[99985], {
          99985: function(m, e, r) { wr = r; }
        }, [[99985]]]);
        window.webpackJsonp.pop();
      } catch { return { error: 'webpack failed' }; }
      
      const mod = wr('fBUP');
      if (!mod) return { error: 'Module not found' };
      
      const result = {};
      result.exports = Object.keys(mod);
      
      const svc = mod.default;
      if (!svc) return { ...result, error: 'No default export' };
      
      // Store reference
      window.__zaloHttpModule = svc;
      
      result.type = typeof svc;
      result.constructor = svc.constructor?.name;
      result.ownKeys = Object.keys(svc).slice(0, 30);
      
      // Get ALL methods from prototype chain
      const allMethods = [];
      let proto = svc;
      while (proto && proto !== Object.prototype) {
        try {
          allMethods.push(...Object.getOwnPropertyNames(proto).filter(m => {
            try { return typeof proto[m] === 'function' && m !== 'constructor'; } catch { return false; }
          }));
        } catch {}
        proto = Object.getPrototypeOf(proto);
      }
      result.allMethods = [...new Set(allMethods)].sort();
      
      return result;
    });
    console.log(JSON.stringify(fBUP, null, 2));

    // 2. Get key method signatures  
    console.log('\n========== KEY METHOD SIGNATURES ==========');
    const sigs = await zaloPage.evaluate(() => {
      const svc = window.__zaloHttpModule;
      if (!svc) return { error: 'No svc' };
      
      const result = {};
      const keyMethods = [
        'request', '_request', '_buildUrl', 
        'sendFriendRequest', 'acceptFriendRequest', 'removeFriend',
        'blockMember', 'unblockMember', 'setBlockFriend',
        'getFriendProfile', 'getFriendsList', 'getRequestedFriends',
        'sendMsg', 'sendMessage', 'forwardMessage',
        'inviteMember', 'createGroup', 'leaveGroup',
        'undoMessage', 'sendSticker',
        'getUserByPhone', 'getUserByUsername',
        'getHistoryMessage', 'getLastMessagesForPreview',
        'sendSeen', 'sendDelivered', 'sendGroupDeliveredV2',
        'sendRequestCall', 'requestCall',
        'deleteOneOneConversationV2', 'deleteGroupConversationV2',
        'deleteOneOneMessageV2', 'deleteGroupMessageV2',
        'setMuteConversation', 'getImportantMsg',
        'createPoll', 'vote', 'createTodo',
        'getMultiUsersByPhones', 'updateAlias', 'removeAlias',
        'getRecommendedFriendsV2', 'requestGetFriendOnlines',
        'updateLanguage', 'searchSticker', 'getListBank',
        'getFriendRequestStatus',
      ];
      
      for (const m of keyMethods) {
        try {
          if (typeof svc[m] === 'function') {
            result[m] = svc[m].toString().slice(0, 600);
          }
        } catch {}
      }
      
      return result;
    });
    console.log(JSON.stringify(sigs, null, 2));

    // 3. Get base request/transport method
    console.log('\n========== BASE TRANSPORT METHODS ==========');
    const transport = await zaloPage.evaluate(() => {
      const svc = window.__zaloHttpModule;
      if (!svc) return { error: 'No svc' };
      
      const result = {};
      
      // Find the base request/transport methods - try all prototype levels
      let proto = svc;
      let level = 0;
      while (proto && proto !== Object.prototype && level < 5) {
        const names = Object.getOwnPropertyNames(proto);
        for (const name of names) {
          try {
            if (typeof proto[name] !== 'function' || name === 'constructor') continue;
            const src = proto[name].toString();
            if (src.includes('XMLHttpRequest') || src.includes('fetch(') || 
                src.includes('zpw_ver') || src.includes('zpw_type') ||
                src.includes('_request') || src.includes('params=') ||
                name === 'request' || name === '_request') {
              result['L' + level + '_' + name] = src.slice(0, 1000);
            }
          } catch {}
        }
        proto = Object.getPrototypeOf(proto);
        level++;
      }
      
      return result;
    });
    console.log(JSON.stringify(transport, null, 2));

    console.log('\n========== DONE ==========');
  } catch(err) {
    console.error('Error:', err.message);
  } finally {
    if (browser) await browser.close();
  }
})();
