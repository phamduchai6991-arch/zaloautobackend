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

  // 1. Await getFriends() promise
  const r1 = await cdpEval(ws, `
    (async () => {
      try {
        const zs = window.$$afmc.zStorage;
        const friends = await zs.getFriends();
        if (!friends) return JSON.stringify({error: 'null result'});
        const info = { type: typeof friends, isArray: Array.isArray(friends) };
        if (Array.isArray(friends)) {
          info.count = friends.length;
          info.sample = friends.slice(0, 2).map(f => {
            const o = {};
            for (const k of Object.keys(f)) {
              const v = f[k];
              if (typeof v === 'string') o[k] = v.substring(0, 100);
              else if (typeof v === 'number' || typeof v === 'boolean' || v === null) o[k] = v;
              else o[k] = typeof v;
            }
            return o;
          });
        } else if (friends instanceof Map) {
          info.size = friends.size;
          let i = 0; info.sample = [];
          for (const [k, v] of friends) {
            const o = {};
            if (v && typeof v === 'object') {
              for (const pk of Object.keys(v)) {
                const pv = v[pk];
                if (typeof pv === 'string') o[pk] = pv.substring(0, 100);
                else if (typeof pv === 'number' || typeof pv === 'boolean' || pv === null) o[pk] = pv;
                else o[pk] = typeof pv;
              }
            }
            info.sample.push({key: k, value: o});
            if (++i >= 2) break;
          }
        } else if (typeof friends === 'object') {
          info.keys = Object.keys(friends).slice(0, 20);
        }
        return JSON.stringify(info, null, 2);
      } catch(e) {
        return JSON.stringify({error: e.message, stack: e.stack?.substring(0, 500)});
      }
    })()
  `, 1);
  console.log('=== getFriends() awaited ===');
  console.log(r1.result?.value);

  // 2. Await getGroups()
  const r2 = await cdpEval(ws, `
    (async () => {
      try {
        const zs = window.$$afmc.zStorage;
        const groups = await zs.getGroups();
        if (!groups) return JSON.stringify({error: 'null result'});
        const info = { type: typeof groups, isArray: Array.isArray(groups) };
        if (Array.isArray(groups)) {
          info.count = groups.length;
          info.sample = groups.slice(0, 2).map(g => {
            const o = {};
            for (const k of Object.keys(g)) {
              const v = g[k];
              if (typeof v === 'string') o[k] = v.substring(0, 100);
              else if (typeof v === 'number' || typeof v === 'boolean' || v === null) o[k] = v;
              else if (Array.isArray(v)) o[k] = 'Array[' + v.length + ']';
              else o[k] = typeof v;
            }
            return o;
          });
        } else if (typeof groups === 'object') {
          info.keys = Object.keys(groups).slice(0, 20);
        }
        return JSON.stringify(info, null, 2);
      } catch(e) {
        return JSON.stringify({error: e.message, stack: e.stack?.substring(0, 300)});
      }
    })()
  `, 2);
  console.log('\n=== getGroups() awaited ===');
  console.log(r2.result?.value);

  // 3. Try extracting rendered friend names from DOM (React fiber)
  const r3 = await cdpEval(ws, `
    (() => {
      // Look for the contact list in the DOM
      // Zalo's left panel has friend names rendered as text
      const contactItems = document.querySelectorAll('[class*="conv-item"], [class*="friend-item"], [class*="contact-item"], [class*="user-name"], [class*="display-name"]');
      if (contactItems.length > 0) {
        return JSON.stringify({
          selector: 'conv-item/friend-item/contact-item/user-name/display-name',
          count: contactItems.length,
          sample: Array.from(contactItems).slice(0, 5).map(el => ({
            class: el.className?.substring(0, 80),
            text: el.textContent?.substring(0, 50),
            tag: el.tagName
          }))
        }, null, 2);
      }
      
      // Try broader search
      const allWithText = document.querySelectorAll('.truncate, [data-translate-inner], span.truncate');
      return JSON.stringify({
        selector: 'broader',
        count: allWithText.length,
        sample: Array.from(allWithText).slice(0, 10).map(el => ({
          class: el.className?.substring(0, 80),
          text: el.textContent?.substring(0, 50),
          tag: el.tagName
        }))
      }, null, 2);
    })()
  `, 3);
  console.log('\n=== DOM contact names ===');
  console.log(r3.result?.value);

  // 4. Explore class names in the DOM to find contact list containers
  const r4 = await cdpEval(ws, `
    (() => {
      // Find all unique class names that might relate to contacts/friends
      const classes = new Set();
      document.querySelectorAll('*').forEach(el => {
        if (el.className && typeof el.className === 'string') {
          el.className.split(/\\s+/).forEach(c => {
            if (/friend|contact|conv|chat|user|name|avatar|list-item|member/i.test(c)) {
              classes.add(c);
            }
          });
        }
      });
      return JSON.stringify(Array.from(classes).sort(), null, 2);
    })()
  `, 4);
  console.log('\n=== Contact-related CSS classes ===');
  console.log(r4.result?.value);

  ws.close();
})();
