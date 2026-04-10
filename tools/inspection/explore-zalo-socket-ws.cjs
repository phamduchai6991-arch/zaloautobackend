/**
 * explore-zalo-socket-ws.cjs
 * 
 * Part 1: Find WebSocket instances and connection URLs
 */

const { chromium } = require('playwright');

(async () => {
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const ctx = browser.contexts()[0];
    const zaloPage = ctx.pages().find(p => p.url().includes('chat.zalo.me'));
    if (!zaloPage) { console.error('No Zalo page'); process.exit(1); }

    // 1. WebSocket from _chatHandler._socket
    console.log('========== SOCKET HANDLERS ==========');
    const wsInfo = await zaloPage.evaluate(() => {
      const sp = window.$$afmc?.socketPolling;
      if (!sp) return { error: 'No socketPolling' };
      
      const result = {};
      
      for (const handlerName of ['_chatHandler', '_ctrlHandler']) {
        const handler = sp[handlerName];
        if (!handler) continue;
        
        const socket = handler._socket;
        if (!socket) { result[handlerName + '._socket'] = null; continue; }
        
        result[handlerName + '._socket'] = {
          constructor: socket.constructor?.name,
          keys: Object.keys(socket).slice(0, 30)
        };
        
        // Look for WS inside
        for (const key of Object.keys(socket)) {
          const val = socket[key];
          if (val instanceof WebSocket) {
            result[handlerName + '.' + key] = { url: val.url, readyState: val.readyState };
          } else if (typeof val === 'string' && (val.startsWith('ws') || val.startsWith('http'))) {
            result[handlerName + '.str_' + key] = val;
          } else if (val && typeof val === 'object' && !(val instanceof Array)) {
            try {
              for (const sk of Object.keys(val).slice(0, 20)) {
                if (val[sk] instanceof WebSocket) {
                  result[handlerName + '.' + key + '.' + sk] = { url: val[sk].url, readyState: val[sk].readyState };
                }
                if (typeof val[sk] === 'string' && (val[sk].startsWith('ws') || val[sk].startsWith('http'))) {
                  result[handlerName + '.' + key + '.str_' + sk] = val[sk];
                }
              }
            } catch {}
          }
        }

        // Get source of key methods
        try { result[handlerName + '.connect_src'] = socket.connect?.toString().slice(0, 500); } catch {}
        try { result[handlerName + '.send_src'] = socket.send?.toString().slice(0, 500); } catch {}
      }
      
      // connectChat* connectors
      for (const key of ['connectChatSocket', 'connectCtrSocket']) {
        const conn = sp[key];
        if (!conn) continue;
        result[key] = { constructor: conn.constructor?.name, keys: Object.keys(conn).slice(0, 30) };
        
        for (const sk of Object.keys(conn)) {
          const val = conn[sk];
          if (val instanceof WebSocket) result[key + '.' + sk] = { url: val.url, readyState: val.readyState };
          if (typeof val === 'string' && (val.startsWith('ws') || val.startsWith('http'))) result[key + '.str_' + sk] = val;
        }
        
        try { result[key + '.connect_src'] = conn.connect?.toString().slice(0, 500); } catch {}
      }
      
      return result;
    });
    console.log(JSON.stringify(wsInfo, null, 2));

    // 2. Find WebSocket by hooking
    console.log('\n========== ALL WEBSOCKET CONNECTIONS ==========');
    const allWs = await zaloPage.evaluate(() => {
      // Use CDP-exposed performance entries for WS
      const entries = performance.getEntriesByType('resource').filter(e => e.name.startsWith('ws'));
      return entries.map(e => ({ url: e.name, type: e.initiatorType, duration: e.duration }));
    });
    console.log(JSON.stringify(allWs, null, 2));

    // 3. Get service worker / shared worker info
    console.log('\n========== WORKERS ==========');
    const workers = await zaloPage.evaluate(() => {
      const result = {};
      
      // Service worker
      if (navigator.serviceWorker?.controller) {
        result.sw = { url: navigator.serviceWorker.controller.scriptURL, state: navigator.serviceWorker.controller.state };
      }
      
      // Get all active registrations
      return navigator.serviceWorker?.getRegistrations?.().then(regs => {
        result.registrations = regs.map(r => ({
          scope: r.scope,
          active: r.active?.scriptURL,
          waiting: r.waiting?.scriptURL,
          installing: r.installing?.scriptURL
        }));
        return result;
      }) || result;
    });
    console.log(JSON.stringify(workers, null, 2));

    // 4. UDP Network.getWebSocketConnections via CDP
    console.log('\n========== CDP WEBSOCKET CONNECTIONS ==========');
    const cdp = await zaloPage.context().newCDPSession(zaloPage);
    await cdp.send('Network.enable');
    
    // Get current connections
    // Listen for any WS activity for 3 seconds
    const connections = [];
    cdp.on('Network.webSocketCreated', p => connections.push({ type: 'created', url: p.url, id: p.requestId }));
    cdp.on('Network.webSocketFrameSent', p => connections.push({ type: 'sent', id: p.requestId, data: p.response.payloadData?.slice(0, 200) }));
    cdp.on('Network.webSocketFrameReceived', p => connections.push({ type: 'recv', id: p.requestId, data: p.response.payloadData?.slice(0, 200) }));
    
    await new Promise(r => setTimeout(r, 5000));
    await cdp.send('Network.disable');
    
    console.log('WS events in 5s:', JSON.stringify(connections, null, 2));

    console.log('\n========== DONE ==========');
  } catch(err) {
    console.error('Error:', err.message);
  } finally {
    if (browser) await browser.close();
  }
})();
