// Inspect Zalo web client internal state via CDP
const http = require('http');
const WebSocket = require('ws');

async function getWsUrl() {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:9222/json', res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const tabs = JSON.parse(d);
        const zalo = tabs.find(t => t.url.includes('chat.zalo.me'));
        if (zalo) resolve(zalo.webSocketDebuggerUrl);
        else reject(new Error('No Zalo tab'));
      });
    });
  });
}

async function cdpEval(ws, expression, id = 1) {
  return new Promise((resolve, reject) => {
    const handler = (msg) => {
      const data = JSON.parse(msg.toString());
      if (data.id === id) {
        ws.removeListener('message', handler);
        resolve(data.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true }
    }));
    setTimeout(() => reject(new Error('timeout')), 10000);
  });
}

async function main() {
  const wsUrl = await getWsUrl();
  const ws = new WebSocket(wsUrl);
  await new Promise(r => ws.on('open', r));
  console.log('Connected to Zalo tab via CDP\n');

  // 1. Check for global Zalo objects  
  const globalsCheck = await cdpEval(ws, `
    (() => {
      const interesting = [];
      const skip = new Set(['chrome','speechSynthesis','caches','cookieStore','ondevicemotion','ondeviceorientation','launchQueue','documentPictureInPicture','getScreenDetails','queryLocalFonts','showDirectoryPicker','showOpenFilePicker','showSaveFilePicker','originAgentCluster','navigation','scheduler','crossOriginIsolated','isSecureContext']);
      for (const key of Object.getOwnPropertyNames(window)) {
        if (skip.has(key)) continue;
        const val = window[key];
        if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof HTMLElement) && !(val instanceof Event)) {
          const keys = Object.keys(val);
          if (keys.length > 0 && keys.length < 50) {
            interesting.push({ name: key, keys: keys.slice(0, 10), type: typeof val });
          }
        }
        if (typeof val === 'function' && (key.toLowerCase().includes('zalo') || key.toLowerCase().includes('friend') || key.toLowerCase().includes('contact') || key.toLowerCase().includes('store') || key.toLowerCase().includes('redux') || key.toLowerCase().includes('state'))) {
          interesting.push({ name: key, type: 'function' });
        }
      }
      return JSON.stringify(interesting, null, 2);
    })()
  `, 1);
  console.log('=== Interesting globals ===');
  console.log(globalsCheck.result?.value || globalsCheck);

  // 2. Check for __NEXT_DATA__, __REDUX_STORE__, etc
  const storeCheck = await cdpEval(ws, `
    (() => {
      const checks = {};
      checks.__NEXT_DATA__ = typeof __NEXT_DATA__ !== 'undefined';
      checks.__REDUX_STORE__ = typeof window.__REDUX_STORE__ !== 'undefined';
      checks.__store__ = typeof window.__store__ !== 'undefined';
      checks.__INITIAL_STATE__ = typeof window.__INITIAL_STATE__ !== 'undefined';
      checks.__APP_STATE__ = typeof window.__APP_STATE__ !== 'undefined';
      checks.ZaloStore = typeof window.ZaloStore !== 'undefined';
      checks.zaloApp = typeof window.zaloApp !== 'undefined';
      checks._store = typeof window._store !== 'undefined';
      // Check for properties containing 'friend', 'contact', 'user'
      const found = [];
      for (const k of Object.getOwnPropertyNames(window)) {
        const kl = k.toLowerCase();
        if (kl.includes('friend') || kl.includes('contact') || kl.includes('user') || kl.includes('profile') || kl.includes('account') || kl.includes('member') || kl.includes('group') || kl.includes('conv') || kl.includes('chat') || kl.includes('msg') || kl.includes('store') || kl.includes('db') || kl.includes('idb') || kl.includes('cache') || kl.includes('zalo') || kl.includes('zpw') || kl.includes('module')) {
          found.push(k + ' = ' + typeof window[k]);
        }
      }
      checks.relevantGlobals = found;
      return JSON.stringify(checks, null, 2);
    })()
  `, 2);
  console.log('\n=== Store/State checks ===');
  console.log(storeCheck.result?.value || storeCheck);

  // 3. Check React fiber tree for friend data
  const reactCheck = await cdpEval(ws, `
    (() => {
      // Find React root
      const rootEl = document.getElementById('root') || document.getElementById('app') || document.querySelector('[data-reactroot]');
      if (!rootEl) return 'No React root found';
      
      const fiberKey = Object.keys(rootEl).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (!fiberKey) return 'No React fiber found. Keys: ' + Object.keys(rootEl).filter(k=>k.startsWith('__')).join(', ');
      
      return 'React fiber found: ' + fiberKey;
    })()
  `, 3);
  console.log('\n=== React check ===');
  console.log(reactCheck.result?.value || reactCheck);

  // 4. Check IndexedDB databases
  const idbCheck = await cdpEval(ws, `
    indexedDB.databases().then(dbs => JSON.stringify(dbs.map(d => ({name: d.name, version: d.version})), null, 2))
  `, 4);
  console.log('\n=== IndexedDB databases ===');
  console.log(idbCheck.result?.value || idbCheck);

  // 5. Check localStorage keys related to friends/contacts
  const lsCheck = await cdpEval(ws, `
    (() => {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        keys.push(k);
      }
      return JSON.stringify(keys);
    })()
  `, 5);
  console.log('\n=== localStorage keys ===');
  console.log(lsCheck.result?.value || lsCheck);

  ws.close();
}

main().catch(console.error);
