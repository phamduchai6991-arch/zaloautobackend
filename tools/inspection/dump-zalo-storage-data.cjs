const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const artifactsDir = path.resolve(__dirname, '../../artifacts/data');

async function getWsUrl() {
  return new Promise((resolve) => {
    http.get('http://localhost:9222/json', res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const tabs = JSON.parse(d);
        const zalo = tabs.find(t => t.url.includes('chat.zalo.me'));
        resolve(zalo.webSocketDebuggerUrl);
      });
    });
  });
}

async function cdpEval(ws, expression, id) {
  return new Promise((resolve) => {
    const handler = (msg) => {
      const data = JSON.parse(msg.toString());
      if (data.id === id) { ws.removeListener('message', handler); resolve(data.result); }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true }}));
    setTimeout(() => resolve({error:'timeout'}), 30000);
  });
}

(async () => {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const ws = new WebSocket(await getWsUrl());
  await new Promise(r => ws.on('open', r));

  // 1. Full friend list
  const r1 = await cdpEval(ws, `
    (async () => {
      const zs = window.$$afmc.zStorage;
      const friends = await zs.getFriends();
      return JSON.stringify(friends.map(f => ({
        userId: f.userId,
        username: f.username,
        displayName: f.displayName,
        zaloName: f.zaloName,
        avatar: f.avatar,
        gender: f.gender,
        dob: f.dob,
        sdob: f.sdob,
        status: f.status,
        phoneNumber: f.phoneNumber,
        isFr: f.isFr,
        isBlocked: f.isBlocked,
        isActive: f.isActive,
        type: f.type,
        globalId: f.globalId,
        bizInfo: f.bizInfo,
        user_mode: f.user_mode
      })));
    })()
  `, 1);
  const friends = JSON.parse(r1.result.value);
  fs.writeFileSync(path.join(artifactsDir, 'zalo-friends.json'), JSON.stringify(friends, null, 2));
  console.log('Friends:', friends.length);
  friends.forEach(f => console.log('  -', f.displayName, '|', f.phoneNumber || 'no phone', '| userId:', f.userId));

  // 2. Full group list
  const r2 = await cdpEval(ws, `
    (async () => {
      const zs = window.$$afmc.zStorage;
      const groups = await zs.getGroups();
      return JSON.stringify(groups.map(g => ({
        userId: g.userId,
        displayName: g.displayName,
        avatar: g.avatar,
        totalMember: g.totalMember,
        memberIds: g.memberIds,
        creatorId: g.creatorId,
        type: g.type,
        subType: g.subType,
        globalId: g.globalId,
        desc: g.desc,
        visibility: g.visibility
      })));
    })()
  `, 2);
  const groups = JSON.parse(r2.result.value);
  fs.writeFileSync(path.join(artifactsDir, 'zalo-groups.json'), JSON.stringify(groups, null, 2));
  console.log('\nGroups:', groups.length);
  groups.forEach(g => console.log('  -', g.displayName, '| members:', g.totalMember, '| id:', g.userId));

  // 3. Check all available zStorage methods
  const r3 = await cdpEval(ws, `
    (() => {
      const zs = window.$$afmc.zStorage;
      const proto = Object.getPrototypeOf(zs);
      const methods = Object.getOwnPropertyNames(proto).filter(k => typeof proto[k] === 'function');
      // Filter for data-related methods
      return JSON.stringify(methods.filter(m => /^(get|find|list|search|load|read|fetch|query)/i.test(m)));
    })()
  `, 3);
  console.log('\n=== Available getter methods ===');
  console.log(JSON.parse(r3.result.value).join(', '));

  // 4. Get group info/members for first group
  const firstGroupId = groups[0]?.userId;
  if (firstGroupId) {
    const r4 = await cdpEval(ws, `
      (async () => {
        const zs = window.$$afmc.zStorage;
        try {
          const info = await zs.getGroupInfo('${firstGroupId}');
          return JSON.stringify(info, null, 2);
        } catch(e) {
          return JSON.stringify({error: e.message});
        }
      })()
    `, 4);
    console.log('\n=== Group info for', groups[0]?.displayName, '===');
    console.log(r4.result?.value?.substring(0, 500));
  }

  // 5. Get conversations
  const r5 = await cdpEval(ws, `
    (async () => {
      try {
        const zs = window.$$afmc.zStorage;
        const convs = await zs.getConversations();
        if (!convs) return JSON.stringify({error: 'null'});
        if (Array.isArray(convs)) {
          return JSON.stringify({count: convs.length, sample: convs.slice(0,2).map(c => ({
            id: c.userId || c.id,
            name: c.displayName,
            type: c.type,
            lastMsg: c.lastMsg?.substring?.(0, 50)
          }))});
        }
        return JSON.stringify({type: typeof convs, keys: Object.keys(convs).slice(0,10)});
      } catch(e) {
        return JSON.stringify({error: e.message});
      }
    })()
  `, 5);
  console.log('\n=== Conversations ===');
  console.log(r5.result?.value);

  ws.close();
  console.log('\nDone! Files saved under artifacts/data');
})();
