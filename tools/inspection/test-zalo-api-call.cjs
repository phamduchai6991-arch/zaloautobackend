/**
 * test-zalo-api-call.cjs
 * Test actual API calls through fBUP module
 * Safe read-only calls only: getFriendsList, getMe, active
 */

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const page = contexts[0].pages().find(p => p.url().includes('chat.zalo.me'));
  if (!page) { console.log('No Zalo page found'); process.exit(1); }

  console.log('=== TEST 1: Call getFriendsList via fBUP ===');
  
  const friendsResult = await page.evaluate(async () => {
    let wr;
    try {
      webpackJsonp.push([['__test_api__'], {
        '__test_api__': function(module, exports, require) { wr = require; }
      }, [['__test_api__']]]);
    } catch(e) {}
    if (!wr) return { error: 'No webpack require' };

    const fBUP = wr('fBUP');
    const httpModule = fBUP.default || fBUP.a || fBUP;
    
    try {
      // Call getFriendsList - this is a safe read-only call
      const response = await httpModule.getFriendsList(0);
      
      // Extract key info from response
      if (response && response.data) {
        const data = response.data;
        return {
          status: response.status,
          error_code: data.error_code,
          error_message: data.error_message,
          friendCount: data.data ? (Array.isArray(data.data) ? data.data.length : 'not-array') : 'no-data',
          sampleFriend: data.data && data.data[0] ? {
            userId: data.data[0].userId,
            displayName: data.data[0].displayName || data.data[0].zaloName,
            avatar: data.data[0].avatar ? 'has_avatar' : 'no_avatar',
            keys: Object.keys(data.data[0]).slice(0, 15)
          } : null,
          responseKeys: Object.keys(data).slice(0, 10)
        };
      }
      return { raw: JSON.stringify(response).substring(0, 500) };
    } catch(e) {
      return { error: e.message, stack: e.stack?.substring(0, 300) };
    }
  });
  
  console.log(JSON.stringify(friendsResult, null, 2));

  console.log('\n=== TEST 2: Call getProfileMeV2 ===');
  
  const profileResult = await page.evaluate(async () => {
    let wr;
    try {
      webpackJsonp.push([['__test_profile__'], {
        '__test_profile__': function(module, exports, require) { wr = require; }
      }, [['__test_profile__']]]);
    } catch(e) {}
    if (!wr) return { error: 'No webpack require' };

    const fBUP = wr('fBUP');
    const httpModule = fBUP.default || fBUP.a || fBUP;
    
    try {
      const response = await httpModule.getProfileMeV2();
      if (response && response.data) {
        const data = response.data;
        return {
          error_code: data.error_code,
          keys: data.data ? Object.keys(data.data).slice(0, 20) : Object.keys(data).slice(0, 20),
          displayName: data.data?.displayName || data.data?.zaloName,
          userId: data.data?.userId
        };
      }
      return { raw: JSON.stringify(response).substring(0, 500) };
    } catch(e) {
      return { error: e.message };
    }
  });
  
  console.log(JSON.stringify(profileResult, null, 2));

  console.log('\n=== TEST 3: Get actual domain URLs ===');
  
  const domainResult = await page.evaluate(() => {
    let wr;
    try {
      webpackJsonp.push([['__test_domains__'], {
        '__test_domains__': function(module, exports, require) { wr = require; }
      }, [['__test_domains__']]]);
    } catch(e) {}
    if (!wr) return { error: 'No webpack require' };

    const fBUP = wr('fBUP');
    const httpModule = fBUP.default || fBUP.a || fBUP;
    
    // The domains are accessed through p.b inside the module scope
    // We can't access p.b directly, but we can extract domain from a URL
    // by looking at what _getCommonParams returns and checking internal state
    
    const info = {
      commonParams: httpModule._getCommonParams(),
      commonParamsObj: httpModule._getCommonParamsObj(),
      userId: httpModule.userId,
      UIN: httpModule.UIN,
    };

    // Try to get domains by looking at the module's internal references
    // The easiest way: check if there's a domain config on a known module
    try {
      // Try to trace a URL by creating a test but NOT sending it
      // We know getFriendsList uses getProfileDomain() + "/api/social/friend/getfriends"
      // so we can XHR intercept to capture the actual URL
      
      // Alternative: check if there's a processConvSettings or any stored URL
      if (httpModule.s) {
        info.sConfig = typeof httpModule.s === 'object' ? 
          Object.keys(httpModule.s).slice(0, 20) : typeof httpModule.s;
      }
    } catch(e) {}

    return info;
  });
  
  console.log(JSON.stringify(domainResult, null, 2));

  console.log('\n=== TEST 4: Call via dThN (business layer) ===');
  
  const dThNResult = await page.evaluate(async () => {
    let wr;
    try {
      webpackJsonp.push([['__test_dThN__'], {
        '__test_dThN__': function(module, exports, require) { wr = require; }
      }, [['__test_dThN__']]]);
    } catch(e) {}
    if (!wr) return { error: 'No webpack require' };

    const dThN = wr('dThN');
    const apiService = dThN.default || dThN.a || dThN;
    
    try {
      // Call via business layer (will also update local storage)
      // getOnlineFriends is safe and read-only
      const result = await apiService.getOnlineFriends();
      if (result) {
        return {
          type: typeof result,
          isArray: Array.isArray(result),
          count: Array.isArray(result) ? result.length : null,
          sample: Array.isArray(result) && result[0] ? result[0] : String(result).substring(0, 300),
          keys: result && typeof result === 'object' ? Object.keys(result).slice(0, 10) : null
        };
      }
      return { result: 'null/undefined' };
    } catch(e) {
      return { error: e.message };
    }
  });
  
  console.log(JSON.stringify(dThNResult, null, 2));

  await browser.close();
  console.log('\n=== DONE ===');
})();
