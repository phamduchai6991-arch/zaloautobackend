const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

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
    setTimeout(() => resolve({error:'timeout'}), 20000);
  });
}

(async () => {
  const ws = new WebSocket(await getWsUrl());
  await new Promise(r => ws.on('open', r));

  // 1. Get friends via zStorage.getFriends()
  const r1 = await cdpEval(ws, `
    (() => {
      try {
        const zs = window.$$afmc.zStorage;
        const friends = zs.getFriends();
        if (!friends) return JSON.stringify({error: 'getFriends returned ' + typeof friends});
        if (friends instanceof Promise) return 'Promise - need await';
        const info = { type: typeof friends, isArray: Array.isArray(friends) };
        if (Array.isArray(friends)) {
          info.count = friends.length;
          info.sample = friends.slice(0, 3);
        } else if (friends instanceof Map) {
          info.size = friends.size;
          let i = 0;
          info.sample = [];
          for (const [k, v] of friends) {
            info.sample.push({key: k, value: v});
            if (++i >= 3) break;
          }
        } else if (typeof friends === 'object') {
          info.keys = Object.keys(friends).slice(0, 10);
          const firstKey = Object.keys(friends)[0];
          if (firstKey) info.firstEntry = JSON.stringify(friends[firstKey]).substring(0, 500);
        }
        return JSON.stringify(info, null, 2);
      } catch(e) {
        return JSON.stringify({error: e.message, stack: e.stack?.substring(0, 300)});
      }
    })()
  `, 1);
  console.log('=== getFriends() ===');
  console.log(r1.result?.value);

  // 2. Read from IndexedDB friend store  
  const r2 = await cdpEval(ws, `
    new Promise((resolve) => {
      const req = indexedDB.open('zdb_708728375746684590');
      req.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('friend', 'readonly');
        const store = tx.objectStore('friend');
        const getAll = store.getAll();
        getAll.onsuccess = () => {
          const friends = getAll.result;
          const info = { count: friends.length };
          if (friends.length > 0) {
            info.sample = friends.slice(0, 3);
            info.keys = Object.keys(friends[0]);
          }
          db.close();
          resolve(JSON.stringify(info, null, 2));
        };
        getAll.onerror = () => { db.close(); resolve('error reading friend store'); };
      };
    })
  `, 2);
  console.log('\n=== IndexedDB friend store ===');
  console.log(r2.result?.value);

  // 3. Read from friends_info store
  const r3 = await cdpEval(ws, `
    new Promise((resolve) => {
      const req = indexedDB.open('zdb_708728375746684590');
      req.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('friends_info', 'readonly');
        const store = tx.objectStore('friends_info');
        const getAll = store.getAll();
        getAll.onsuccess = () => {
          const items = getAll.result;
          const info = { count: items.length };
          if (items.length > 0) {
            info.sample = items.slice(0, 3);
            info.keys = Object.keys(items[0]);
          }
          db.close();
          resolve(JSON.stringify(info, null, 2));
        };
        getAll.onerror = () => { db.close(); resolve('error'); };
      };
    })
  `, 3);
  console.log('\n=== IndexedDB friends_info store ===');
  console.log(r3.result?.value);

  // 4. Read conversation store (to see friend names from conversations)
  const r4 = await cdpEval(ws, `
    new Promise((resolve) => {
      const req = indexedDB.open('zdb_708728375746684590');
      req.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('conversation', 'readonly');
        const store = tx.objectStore('conversation');
        const getAll = store.getAll();
        getAll.onsuccess = () => {
          const convs = getAll.result;
          const info = { count: convs.length };
          if (convs.length > 0) {
            info.keys = Object.keys(convs[0]);
            info.sample = convs.slice(0, 2).map(c => {
              const summary = {};
              for (const k of Object.keys(c)) {
                const v = c[k];
                if (typeof v === 'string' && v.length < 100) summary[k] = v;
                else if (typeof v === 'number' || typeof v === 'boolean') summary[k] = v;
                else summary[k] = typeof v + (Array.isArray(v) ? '['+v.length+']' : '');
              }
              return summary;
            });
          }
          db.close();
          resolve(JSON.stringify(info, null, 2));
        };
        getAll.onerror = () => { db.close(); resolve('error'); };
      };
    })
  `, 4);
  console.log('\n=== IndexedDB conversation store ===');
  console.log(r4.result?.value);

  // 5. Read group store
  const r5 = await cdpEval(ws, `
    new Promise((resolve) => {
      const req = indexedDB.open('zdb_708728375746684590');
      req.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('group', 'readonly');
        const store = tx.objectStore('group');
        const getAll = store.getAll();
        getAll.onsuccess = () => {
          const groups = getAll.result;
          const info = { count: groups.length };
          if (groups.length > 0) {
            info.keys = Object.keys(groups[0]);
            info.sample = groups.slice(0, 2).map(g => {
              const summary = {};
              for (const k of Object.keys(g)) {
                const v = g[k];
                if (typeof v === 'string' && v.length < 100) summary[k] = v;
                else if (typeof v === 'number' || typeof v === 'boolean') summary[k] = v;
                else summary[k] = typeof v + (Array.isArray(v) ? '['+v.length+']' : '');
              }
              return summary;
            });
          }
          db.close();
          resolve(JSON.stringify(info, null, 2));
        };
        getAll.onerror = () => { db.close(); resolve('error'); };
      };
    })
  `, 5);
  console.log('\n=== IndexedDB group store ===');
  console.log(r5.result?.value);

  ws.close();
})();
