const http = require('http');
const WebSocket = require('ws');

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
    setTimeout(() => resolve({error:'timeout'}), 10000);
  });
}

(async () => {
  const ws = new WebSocket(await getWsUrl());
  await new Promise(r => ws.on('open', r));

  // Check FriendListManager deeply
  const r1 = await cdpEval(ws, `
    (() => {
      const flm = window.FriendListManager;
      if (!flm) return 'FriendListManager not found';
      const info = {
        keys: Object.keys(flm),
        _loadedFriend: typeof flm._loadedFriend,
        loadedFriendValue: flm._loadedFriend,
      };
      const proto = Object.getPrototypeOf(flm);
      if (proto) {
        info.protoMethods = Object.getOwnPropertyNames(proto).filter(k => typeof proto[k] === 'function');
      }
      return JSON.stringify(info, null, 2);
    })()
  `, 1);
  console.log('=== FriendListManager ===');
  console.log(r1.result?.value);

  // Check $$afmc deeply - zStorage
  const r2 = await cdpEval(ws, `
    (() => {
      const afmc = window.$$afmc;
      if (!afmc) return 'not found';
      const info = { keys: Object.keys(afmc) };
      if (afmc.zStorage) {
        info.zStorageKeys = Object.keys(afmc.zStorage);
        const proto = Object.getPrototypeOf(afmc.zStorage);
        if (proto) info.zStorageMethods = Object.getOwnPropertyNames(proto).filter(k => typeof proto[k] === 'function').slice(0,30);
      }
      return JSON.stringify(info, null, 2);
    })()
  `, 2);
  console.log('\n=== $$afmc ===');
  console.log(r2.result?.value);

  // Check $$AFMC_Container registry
  const r3 = await cdpEval(ws, `
    (() => {
      const c = window.$$AFMC_Container;
      if (!c) return 'not found';
      const info = { keys: Object.keys(c) };
      if (c._registry) {
        const regKeys = [];
        if (c._registry instanceof Map) {
          for (const [k] of c._registry) regKeys.push(String(k));
        } else {
          regKeys.push(...Object.keys(c._registry));
        }
        info.registryKeys = regKeys.slice(0,50);
      }
      return JSON.stringify(info, null, 2);
    })()
  `, 3);
  console.log('\n=== $$AFMC_Container ===');
  console.log(r3.result?.value);

  // Check __BannerPromotion.friends
  const r4 = await cdpEval(ws, `
    (() => {
      const bp = window.__BannerPromotion;
      if (!bp) return 'not found';
      const info = { keys: Object.keys(bp) };
      if (bp.friends) {
        info.friendsType = typeof bp.friends;
        if (Array.isArray(bp.friends)) {
          info.friendsCount = bp.friends.length;
          info.firstFriend = bp.friends[0];
        } else if (bp.friends instanceof Map) {
          info.friendsSize = bp.friends.size;
          const first = bp.friends.entries().next().value;
          info.firstFriend = first;
        } else {
          info.friendsKeys = Object.keys(bp.friends).slice(0, 10);
        }
      }
      return JSON.stringify(info, null, 2);
    })()
  `, 4);
  console.log('\n=== __BannerPromotion ===');
  console.log(r4.result?.value);

  // Check IndexedDB for friend data
  const r5 = await cdpEval(ws, `
    indexedDB.databases().then(dbs => JSON.stringify(dbs.map(d => ({name: d.name, version: d.version})), null, 2))
  `, 5);
  console.log('\n=== IndexedDB databases ===');
  console.log(r5.result?.value);

  ws.close();
})();
