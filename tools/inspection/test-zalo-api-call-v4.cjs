/**
 * test-zalo-api-call-v4.cjs
 * Fix the broken XHR.send, then test API calls
 */

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const page = contexts[0].pages().find(p => p.url().includes('chat.zalo.me'));
  if (!page) { console.log('No Zalo page found'); process.exit(1); }

  console.log('=== Step 1: Fix broken XHR.send ===');
  
  await page.evaluate(() => {
    // The previous trace script patched XHR.send but window.__apiTrace is now gone
    // Fix by providing the array it expects
    if (!window.__apiTrace) {
      window.__apiTrace = [];
    }
  });

  console.log('Fixed window.__apiTrace');

  console.log('\n=== Step 2: Test keepAlive API call ===');
  
  const result = await page.evaluate(async () => {
    let wr;
    try {
      webpackJsonp.push([['__v4__'], {
        '__v4__': function(module, exports, require) { wr = require; }
      }, [['__v4__']]]);
    } catch(e) {}
    if (!wr) return { error: 'No webpack require' };

    const fBUP = wr('fBUP');
    const httpModule = fBUP.default;
    const output = {};
    
    // Test raw XHR first
    try {
      const testResult = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', '/favicon.ico');
        xhr.onload = () => resolve({ status: xhr.status });
        xhr.onerror = (e) => reject(new Error('XHR failed'));
        xhr.send();
      });
      output.rawXhrFixed = testResult;
    } catch(e) {
      output.rawXhrStillBroken = e.message;
      return output; // Don't continue if XHR is still broken
    }

    // Test keepAlive via fBUP
    try {
      const response = await httpModule.keepAlive();
      output.keepAlive = {
        status: response?.status,
        errorCode: response?.data?.error_code,
        data: response?.data ? JSON.stringify(response.data).substring(0, 300) : null
      };
    } catch(e) {
      output.keepAliveError = e.message;
    }

    // Test getFriendsList
    try {
      const response = await httpModule.getFriendsList(0);
      if (response?.data) {
        const d = response.data;
        output.getFriendsList = {
          errorCode: d.error_code,
          dataLength: Array.isArray(d.data) ? d.data.length : typeof d.data,
          sampleKeys: d.data?.[0] ? Object.keys(d.data[0]).slice(0, 15) : null,
          sample: d.data?.[0] ? {
            userId: d.data[0].userId,
            displayName: d.data[0].displayName || d.data[0].zaloName
          } : null
        };
      }
    } catch(e) {
      output.getFriendsListError = e.message;
    }

    // Test getProfileMeV2
    try {
      const response = await httpModule.getProfileMeV2();
      if (response?.data) {
        const d = response.data;
        output.profile = {
          errorCode: d.error_code,
          keys: d.data ? Object.keys(d.data).slice(0, 20) : null,
          display: d.data?.displayName || d.data?.zaloName
        };
      }
    } catch(e) {
      output.profileError = e.message;
    }

    // Test requestGetFriendOnlines
    try {
      const response = await httpModule.requestGetFriendOnlines();
      if (response?.data) {
        output.onlineFriends = {
          errorCode: response.data.error_code,
          count: Array.isArray(response.data.data) ? response.data.data.length : typeof response.data.data
        };
      }
    } catch(e) {
      output.onlineFriendsError = e.message;
    }

    return output;
  });
  
  console.log(JSON.stringify(result, null, 2));

  console.log('\n=== Step 3: Test sendIsTyping (safe, no side effects) ===');
  
  const typingResult = await page.evaluate(async () => {
    let wr;
    try {
      webpackJsonp.push([['__v4b__'], {
        '__v4b__': function(module, exports, require) { wr = require; }
      }, [['__v4b__']]]);
    } catch(e) {}
    if (!wr) return { error: 'No webpack require' };

    const fBUP = wr('fBUP');
    const httpModule = fBUP.default;

    // Get userId and UIN
    const info = {
      userId: httpModule.userId,
      UIN: httpModule.UIN,
      zaloClientID: null
    };

    try {
      const X4fA = wr('X4fA');
      info.zaloClientID = X4fA.a.getZaloClientID();
    } catch(e) {}

    // Test typing indicator to self (harmless)
    try {
      const response = await httpModule.sendIsTyping(info.userId, false);
      info.typingResult = {
        status: response?.status,
        errorCode: response?.data?.error_code,
        data: response?.data ? JSON.stringify(response.data).substring(0, 200) : null
      };
    } catch(e) {
      info.typingError = e.message;
    }

    return info;
  });

  console.log(JSON.stringify(typingResult, null, 2));

  await browser.close();
  console.log('\n=== DONE ===');
})();
