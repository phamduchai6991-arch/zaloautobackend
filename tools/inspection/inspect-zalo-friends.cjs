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
    setTimeout(() => resolve({error:'timeout'}), 15000);
  });
}

(async () => {
  const ws = new WebSocket(await getWsUrl());
  await new Promise(r => ws.on('open', r));

  // 1. Check friendCache
  const r1 = await cdpEval(ws, `
    (() => {
      const zs = window.$$afmc && window.$$afmc.zStorage;
      if (!zs) return 'zStorage not found';
      const fc = zs.friendCache;
      if (!fc) return 'friendCache is ' + typeof fc;
      const info = { type: typeof fc };
      if (fc instanceof Map) {
        info.size = fc.size;
        const entries = [];
        let i = 0;
        for (const [k, v] of fc) {
          entries.push({ key: k, value: typeof v === 'object' ? Object.keys(v) : typeof v });
          if (++i >= 3) break;
        }
        info.sampleEntries = entries;
      } else if (typeof fc === 'object') {
        info.keys = Object.keys(fc).slice(0, 20);
        const firstKey = Object.keys(fc)[0];
        if (firstKey) {
          const val = fc[firstKey];
          info.firstValue = typeof val === 'object' ? Object.keys(val).slice(0,20) : typeof val;
        }
      }
      return JSON.stringify(info, null, 2);
    })()
  `, 1);
  console.log('=== friendCache ===');
  console.log(r1.result?.value);

  // 2. More zStorage methods - find friend-related methods
  const r2 = await cdpEval(ws, `
    (() => {
      const zs = window.$$afmc && window.$$afmc.zStorage;
      if (!zs) return 'not found';
      const proto = Object.getPrototypeOf(zs);
      const allMethods = Object.getOwnPropertyNames(proto).filter(k => typeof proto[k] === 'function');
      const friendMethods = allMethods.filter(m => /friend|contact|profile|member|group|phone|block/i.test(m));
      return JSON.stringify({ friendRelevant: friendMethods, total: allMethods.length }, null, 2);
    })()
  `, 2);
  console.log('\n=== Friend-related zStorage methods ===');
  console.log(r2.result?.value);

  // 3. Read IndexedDB zdb_* for friend/contact object stores
  const r3 = await cdpEval(ws, `
    new Promise((resolve) => {
      const dbName = 'zdb_708728375746684590';
      const req = indexedDB.open(dbName);
      req.onsuccess = (e) => {
        const db = e.target.result;
        const storeNames = Array.from(db.objectStoreNames);
        db.close();
        resolve(JSON.stringify(storeNames));
      };
      req.onerror = () => resolve('error opening db');
    })
  `, 3);
  console.log('\n=== zdb object stores ===');
  console.log(r3.result?.value);

  // 4. Read from zlocalstorage for friend data
  const r4 = await cdpEval(ws, `
    new Promise((resolve) => {
      const req = indexedDB.open('zlocalstorage');
      req.onsuccess = (e) => {
        const db = e.target.result;
        const storeNames = Array.from(db.objectStoreNames);
        resolve(JSON.stringify(storeNames));
      };
      req.onerror = () => resolve('error');
    })
  `, 4);
  console.log('\n=== zlocalstorage stores ===');
  console.log(r4.result?.value);

  // 5. Try to get lazyGetDataManager which might have friend list
  const r5 = await cdpEval(ws, `
    (() => {
      const zs = window.$$afmc && window.$$afmc.zStorage;
      if (!zs) return 'not found';
      try {
        const dm = zs.lazyGetDataManager();
        if (!dm) return 'dataManager is null';
        const info = { type: typeof dm };
        if (typeof dm === 'object') {
          info.keys = Object.keys(dm).slice(0, 30);
          const proto = Object.getPrototypeOf(dm);
          if (proto) info.methods = Object.getOwnPropertyNames(proto).filter(k => typeof proto[k] === 'function').slice(0, 30);
        }
        return JSON.stringify(info, null, 2);
      } catch(e) {
        return 'Error: ' + e.message;
      }
    })()
  `, 5);
  console.log('\n=== DataManager ===');
  console.log(r5.result?.value);

  ws.close();
})();
