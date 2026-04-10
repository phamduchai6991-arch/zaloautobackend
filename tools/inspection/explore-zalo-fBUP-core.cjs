/**
 * explore-zalo-fBUP-core.cjs
 * Find the CORE methods in fBUP module:
 * - sendFriendRequest, removeFriend, acceptFriendRequest, blockMember
 * - sendMsg (text message sending)
 * - _get, _post, _postSendMsg (base transport)
 * - _getCommonParams, _encodeParams
 * - getFriendsList
 * - setBlockFriend, getUserByPhone
 * - createGroup, inviteMember
 */

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const page = contexts[0].pages().find(p => p.url().includes('chat.zalo.me'));
  if (!page) { console.log('No Zalo page found'); process.exit(1); }

  const result = await page.evaluate(() => {
    // Get webpack require
    let wr;
    try {
      webpackJsonp.push([['__probe_core__'], {
        '__probe_core__': function(module, exports, require) { wr = require; }
      }, [['__probe_core__']]]);
    } catch(e) {}
    if (!wr) return { error: 'No webpack require' };

    const fBUP = wr('fBUP');
    const httpModule = fBUP.default || fBUP.a || fBUP;
    const proto = Object.getPrototypeOf(httpModule);
    
    const output = {};

    // Target methods to get full source
    const targetMethods = [
      // Friend operations
      'sendFriendRequest', 'removeFriend', 'acceptFriendRequest', 
      'blockMember', 'setBlockFriend', 'getUserByPhone',
      'getFriendsList', 'getProfile', 'getFullProfile',
      // Message sending (text)
      'sendMsg', 'sendMessage', 'sendText', 'sendTextMessage',
      // Group operations  
      'createGroup', 'inviteMember', 'kickoutMember', 'leaveGroup',
      'changeGroupName', 'changeGroupAvatar', 'disperseGroup',
      // BASE TRANSPORT
      '_get', '_post', '_postSendMsg', '_postSendMsgAES',
      '_getCommonParams', '_encodeParams', '_handleResponse',
      '_request', 'request', 'buildParams', 'transformParams',
      // Group setting
      'updateGroupSetting', 'changeGroupSetting',
      // Conversation
      'getConversations', 'getListConversation', 'getRecentConversation',
      'sendSeen', 'markRead',
      // Pin message
      'pinMsg', 'unpinMsg', 'pinMessage', 'unpinMessage',
    ];

    // Search on instance, prototype, and prototype chain
    const searchTargets = [
      { name: 'instance', obj: httpModule },
      { name: 'proto', obj: proto },
    ];
    
    // Also get prototype of prototype if exists
    const proto2 = Object.getPrototypeOf(proto);
    if (proto2 && proto2 !== Object.prototype) {
      searchTargets.push({ name: 'proto2', obj: proto2 });
    }

    for (const target of searchTargets) {
      const allKeys = [];
      try {
        const ownKeys = Object.getOwnPropertyNames(target.obj);
        allKeys.push(...ownKeys);
      } catch(e) {}

      for (const method of targetMethods) {
        if (output[method]) continue; // already found
        
        // Exact match
        if (allKeys.includes(method)) {
          try {
            const fn = target.obj[method];
            if (typeof fn === 'function') {
              output[method] = {
                found: target.name,
                source: fn.toString().substring(0, 3000)
              };
            }
          } catch(e) {}
        }
      }
    }

    // Also search by partial name match for methods we might have wrong
    const allProtoKeys = Object.getOwnPropertyNames(proto).sort();
    const friendMethods = allProtoKeys.filter(k => 
      /friend|block|stranger|accept|reject|deny|profile|user/i.test(k)
    );
    const msgMethods = allProtoKeys.filter(k => 
      /^send(?!Sticker|Voice|File|Photo|Link|Mention|Quote|Reaction|Typing|Clear|Log|Hold|Cancel|End|Ring|Answer|Request|Join|On|Off|Fall|Action)/i.test(k)
    );
    const baseMethods = allProtoKeys.filter(k => 
      /^_(?:get|post|send|request|handle|encode|common|build|transform)/i.test(k)
    );
    const convMethods = allProtoKeys.filter(k =>
      /conver|seen|read|pin(?!g)/i.test(k)
    );
    const groupMethods = allProtoKeys.filter(k =>
      /group|member|admin|owner|dispers|leave/i.test(k) && !/Topic|Board|Call|Poll|E2ee|Quote|Sticker|Photo|Link/i.test(k)
    );

    output.__friendMethods = friendMethods;
    output.__msgSendMethods = msgMethods;
    output.__baseMethods = baseMethods;
    output.__convMethods = convMethods;
    output.__groupMethods = groupMethods;

    // Now get sources for base methods and friend methods
    const importantMethods = [
      ...baseMethods, 
      ...friendMethods.slice(0, 20),
      ...msgMethods.slice(0, 10),
      ...groupMethods.slice(0, 15),
    ];

    for (const key of importantMethods) {
      if (output[key]) continue;
      try {
        const fn = proto[key];
        if (typeof fn === 'function') {
          output[key] = {
            found: 'proto',
            source: fn.toString().substring(0, 3000)
          };
        }
      } catch(e) {}
    }

    return output;
  });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();
