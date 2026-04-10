/**
 * explore-zalo-fBUP-msg.cjs
 * Find text message sending methods and remaining critical methods
 */

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const page = contexts[0].pages().find(p => p.url().includes('chat.zalo.me'));
  if (!page) { console.log('No Zalo page found'); process.exit(1); }

  const result = await page.evaluate(() => {
    let wr;
    try {
      webpackJsonp.push([['__probe_msg__'], {
        '__probe_msg__': function(module, exports, require) { wr = require; }
      }, [['__probe_msg__']]]);
    } catch(e) {}
    if (!wr) return { error: 'No webpack require' };

    const fBUP = wr('fBUP');
    const httpModule = fBUP.default || fBUP.a || fBUP;
    const proto = Object.getPrototypeOf(httpModule);
    
    const output = {};

    // 1. Find ALL methods with "send" + "msg" or "message" in name (text message)
    const allKeys = Object.getOwnPropertyNames(proto);
    const instanceKeys = Object.getOwnPropertyNames(httpModule);
    const allCombined = [...new Set([...allKeys, ...instanceKeys])].sort();
    
    // Find msg/message methods
    const msgMethods = allCombined.filter(k => 
      /^send.*msg|^sendMessage|^sendText|^apiSend/i.test(k)
    );
    output._msgMethods = msgMethods;

    // Find ALL instance-level methods (not on proto)
    const instanceOnly = instanceKeys.filter(k => {
      try { return typeof httpModule[k] === 'function'; } catch(e) { return false; }
    }).sort();
    output._instanceMethods = instanceOnly;

    // Get critical missing method sources
    const targetMethods = [
      // Text message sending
      'sendMsg', 'sendMessage', 'sendTextMsg', 'sendTextMessage',
      // Other group ops
      'kickoutMember', 'changeGroupName', 'updateGroupName', 
      // Common params
      '_getCommonParamsObj', '_constructUrlParams',
      // Get profile
      'getProfile', 'getFullProfile', 'getProfileInfo',
      // Pin message
      'pinMsg', 'unpinMsg', 'pinMessage',
      // Search
      'searchFriend', 'searchGlobal',
      // Change settings
      'changeSetting', 'updateSetting',
      // Get conversations
      'getConversations', 'getListConversation', 'getRecentConversation',
      // Mark read
      'markRead', 'sendSeenGroup',
    ];

    for (const method of targetMethods) {
      // Check instance first
      if (typeof httpModule[method] === 'function') {
        output[method] = { found: 'instance', source: httpModule[method].toString().substring(0, 2000) };
      } else if (typeof proto[method] === 'function') {
        output[method] = { found: 'proto', source: proto[method].toString().substring(0, 2000) };
      }
    }

    // 2. Find the `ie` constant (commonParams object) used by _getCommonParams
    // _getCommonParams returns this._constructUrlParams(ie)
    // Let's call it to see what it returns
    try {
      output._commonParamsResult = httpModule._getCommonParams();
    } catch(e) {
      output._commonParamsError = e.message;
    }

    // 3. Get _getCommonParamsObj source
    if (typeof httpModule._getCommonParamsObj === 'function') {
      output._getCommonParamsObj = { source: httpModule._getCommonParamsObj.toString() };
    }
    if (typeof httpModule._constructUrlParams === 'function') {
      output._constructUrlParams = { source: httpModule._constructUrlParams.toString() };
    }

    // 4. Find the sendMsg method - it might be on the dThN layer not fBUP
    // Let's also check dThN for the actual text message send
    try {
      const dThN = wr('dThN');
      const apiService = dThN.default || dThN.a || dThN;
      // Look for send-related methods
      const dThNKeys = Object.getOwnPropertyNames(apiService).filter(k => {
        try { return typeof apiService[k] === 'function'; } catch(e) { return false; }
      }).sort();
      
      const sendMethods = dThNKeys.filter(k => /send.*msg|sendMessage|sendText/i.test(k));
      output._dThN_sendMethods = sendMethods;
      
      // Get sendMsgObject source (this is the main text send method in dThN)
      if (typeof apiService.sendMsgObject === 'function') {
        output.sendMsgObject_dThN = { source: apiService.sendMsgObject.toString().substring(0, 3000) };
      }
      
      // Also look for apiSendMsg or similar
      const apiMethods = dThNKeys.filter(k => /^api/i.test(k));
      output._dThN_apiMethods = apiMethods;
      
      // Get sources for key api methods
      for (const m of apiMethods.slice(0, 10)) {
        if (typeof apiService[m] === 'function') {
          output['dThN_' + m] = { source: apiService[m].toString().substring(0, 1500) };
        }
      }
    } catch(e) {
      output._dThN_error = e.message;
    }

    // 5. Get domain info from p.b
    try {
      // Access domains through the httpModule itself
      const domains = {};
      const domainMethods = ['getChatDomain', 'getGroupDomain', 'getFileDomain', 
        'getProfileDomain', 'getFriendDomain', 'getStickerDomain', 'getConversationDomain',
        'getAliasDomain', 'getLabelDomain', 'getReactionDomain', 'getGroupBoardDomain',
        'getGroupPollDomain', 'getE2eeDomain', 'getE2eeGroupDomain', 'getVoiceCallDomain',
        'getAutoReplyDomain', 'getQuickMessageDomain', 'getGroupCloudDomain',
        'getMediaCloudDomain', 'getRecentSearchDomain'];
      
      // These are on p.b which we can't directly access, but we can try to find them
      // through the actual URL patterns we've seen
      output._domainNote = 'Domains accessed via p.b.getXxxDomain() inside module scope';
    } catch(e) {}

    // 6. Get actual domain values by calling a simple method and intercepting
    try {
      // We know _getCommonParams returns zpw_ver=681&zpw_type=30 format
      // Let's also get zpw_type and zpw_ver values
      const params = httpModule._getCommonParams();
      output._commonParams = params;
      
      // Get the UIN and userId stored on the module
      output._userId = httpModule.userId;
      output._UIN = httpModule.UIN;
    } catch(e) {}

    // 7. Look for the text message send at fBUP level - check the _postSendMsg pattern
    // Text messages in Zalo go through sendMsg on fBUP which is called from dThN
    // Let's search for all methods containing 'Msg' but not specific types
    const textMsgCandidates = allCombined.filter(k => 
      /^send(?!Sticker|Voice|File|Photo|Link|Mention|Quote|Reaction|Typing|Clear|Log|Hold|Cancel|End|Ring|Answer|Request|Join|On|Off|Fall|Action|Seen|Fallback|MsgPhoto|MsgFile|Call|Multi|Group|One|E2ee)/i.test(k)
    );
    output._textMsgCandidates = textMsgCandidates;

    // Get their sources
    for (const m of textMsgCandidates) {
      if (output[m]) continue;
      try {
        const fn = httpModule[m] || proto[m];
        if (typeof fn === 'function') {
          output[m] = { found: 'combined', source: fn.toString().substring(0, 2000) };
        }
      } catch(e) {}
    }

    return output;
  });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();
