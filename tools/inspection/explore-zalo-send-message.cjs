/**
 * explore-zalo-send-message.cjs
 * 
 * Get sendMsgObject, forwardMessage signatures and find the r.default HTTP module
 */

const { chromium } = require('playwright');

(async () => {
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const ctx = browser.contexts()[0];
    const zaloPage = ctx.pages().find(p => p.url().includes('chat.zalo.me'));
    if (!zaloPage) { console.error('No Zalo page'); process.exit(1); }

    // 1. Get message-related methods from dThN
    console.log('========== MESSAGE METHODS ==========');
    const msgMethods = await zaloPage.evaluate(() => {
      let wr = null;
      try {
        window.webpackJsonp.push([[99990], {
          99990: function(m, e, r) { wr = r; }
        }, [[99990]]]);
        window.webpackJsonp.pop();
      } catch { return { error: 'webpack failed' }; }
      
      const svc = wr('dThN').default;
      const result = {};
      
      const methods = [
        'sendMsgObject', 'forwardMessage', 'forwardMultiMessage', 'apiForwardMessage',
        'sendSticker', 'sendSeen', 'sendDelivered', 'undoMessage',
        'blockConversation', 'muteConversation', 'getHistoryMessage',
        'forwardFile', 'fetchImportantMsg',
        'authenticate', 'poll', 'getLastMessagesForPreview',
        'sendRequestCall', 'requestCall',
        'createPoll', 'vote',
        'syncDeleteConversation', 'syncDeleteMessage',
        'createTodo', 'getUserByPhone', 'getMultiUsersByPhones'
      ];
      
      for (const m of methods) {
        try {
          if (typeof svc[m] === 'function') {
            result[m] = svc[m].toString().slice(0, 800);
          }
        } catch {}
      }
      
      return result;
    });
    console.log(JSON.stringify(msgMethods, null, 2));

    // 2. Find the r.default HTTP module
    console.log('\n========== HTTP API MODULE (r.default) ==========');
    const httpModule = await zaloPage.evaluate(() => {
      let wr = null;
      try {
        window.webpackJsonp.push([[99989], {
          99989: function(m, e, r) { wr = r; }
        }, [[99989]]]);
        window.webpackJsonp.pop();
      } catch { return { error: 'webpack failed' }; }
      
      // r.default is imported by dThN. We need to find which module has
      // sendFriendRequest, acceptFriendRequest, removeFriend, getFriendProfile etc.
      
      const ids = Object.keys(wr.c);
      const result = {};
      
      for (const id of ids) {
        try {
          const mod = wr.c[id].exports;
          if (!mod) continue;
          
          const exp = mod.default;
          if (!exp || typeof exp !== 'object') continue;
          
          // Check if this module has the right combination of methods
          const keys = Object.keys(exp);
          if (keys.includes('sendFriendRequest') && keys.includes('removeFriend') && keys.includes('acceptFriendRequest')) {
            result.moduleId = id;
            result.allMethods = keys.filter(k => typeof exp[k] === 'function').slice(0, 100);
            
            // Get key signatures
            result.signatures = {};
            const sigMethods = [
              'sendFriendRequest', 'acceptFriendRequest', 'removeFriend',
              'blockMember', 'unblockMember', 'getFriendProfile', 
              'inviteMember', 'leaveGroup', 'createGroup',
              'sendMsg', 'sendMessage', 'requestGetFriendOnlines',
              'getRequestedFriends', 'getRecommendedFriendsV2',
              'getFriendRequestStatus', 'getUserByUsername',
              'updateAlias', 'removeAlias',
              'searchSticker', 'getListBank', 'updateLanguage',
              'getFriendsList', 'request', '_request'
            ];
            
            for (const m of sigMethods) {
              if (typeof exp[m] === 'function') {
                result.signatures[m] = exp[m].toString().slice(0, 600);
              }
            }
            
            // Store for later use
            window.__zaloHttpApi = exp;
            break;
          }
        } catch {}
      }
      
      // If not found, try searching for modules with getFriendsList
      if (!result.moduleId) {
        for (const id of ids) {
          try {
            const mod = wr.c[id].exports;
            if (!mod) continue;
            const exp = mod.default;
            if (!exp || typeof exp !== 'object') continue;
            
            if (typeof exp.getFriendsList === 'function') {
              result.altModuleId = id;
              result.altMethods = Object.keys(exp).filter(k => typeof exp[k] === 'function').slice(0, 30);
              break;
            }
          } catch {}
        }
      }
      
      return result;
    });
    console.log(JSON.stringify(httpModule, null, 2));

    console.log('\n========== DONE ==========');
  } catch(err) {
    console.error('Error:', err.message);
  } finally {
    if (browser) await browser.close();
  }
})();
