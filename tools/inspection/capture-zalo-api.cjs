// Script to capture ALL network requests from Zalo via Chrome DevTools Protocol
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const CDP_URL = 'ws://localhost:9222/devtools/page/57C0A8941BBAE0BABEE52D751E3D06B6';

const ws = new WebSocket(CDP_URL);
const artifactsDir = path.resolve(__dirname, '../../artifacts/data');
const capturedRequests = [];
let msgId = 1;

function send(method, params = {}) {
  ws.send(JSON.stringify({ id: msgId++, method, params }));
}

ws.on('open', () => {
  console.log('[CDP] Connected to Zalo tab');
  console.log('[CDP] Enabling Network monitoring...');
  send('Network.enable', { maxTotalBufferSize: 10000000 });
  console.log('[CDP] Ready! Interact with Zalo now.');
  console.log('[CDP] Press Ctrl+C when done, results will be saved.\n');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  
  // Network request
  if (msg.method === 'Network.requestWillBeSent') {
    const req = msg.params.request;
    const url = req.url;
    
    // Skip static assets
    if (url.match(/\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|ico)(\?|$)/)) return;
    if (url.includes('chrome-extension://')) return;
    if (url.includes('google-analytics') || url.includes('googletagmanager')) return;
    
    const entry = {
      timestamp: new Date().toISOString(),
      requestId: msg.params.requestId,
      method: req.method,
      url: url,
      postData: req.postData || null,
      type: msg.params.type || '',
      initiator: msg.params.initiator?.url || msg.params.initiator?.type || '',
    };
    
    capturedRequests.push(entry);
    
    // Log important ones immediately
    const shortUrl = url.length > 120 ? url.substring(0, 120) + '...' : url;
    console.log(`[${req.method}] ${shortUrl}`);
    if (req.postData) {
      const pd = req.postData.length > 200 ? req.postData.substring(0, 200) + '...' : req.postData;
      console.log(`  POST: ${pd}`);
    }
  }
  
  // Network response
  if (msg.method === 'Network.responseReceived') {
    const resp = msg.params.response;
    const reqId = msg.params.requestId;
    const existing = capturedRequests.find(r => r.requestId === reqId);
    if (existing) {
      existing.status = resp.status;
      existing.mimeType = resp.mimeType;
      existing.responseHeaders = resp.headers;
      
      // Try to get response body for API calls
      if (resp.mimeType?.includes('json') || resp.mimeType?.includes('text')) {
        send('Network.getResponseBody', { requestId: reqId });
      }
    }
  }
  
  // Response body
  if (msg.id && msg.result?.body) {
    // Find the request we asked for
    const bodyStr = msg.result.body;
    // Store truncated body with matching request
    // We can't easily map response back to request here, so store all bodies
    capturedRequests.push({
      _responseBody: true,
      _msgId: msg.id,
      bodyPreview: bodyStr.substring(0, 2000),
      bodyLength: bodyStr.length,
    });
  }
  
  // WebSocket events
  if (msg.method === 'Network.webSocketFrameReceived') {
    const payload = msg.params.response?.payloadData || '';
    if (payload.length > 50) {
      capturedRequests.push({
        timestamp: new Date().toISOString(),
        type: 'WebSocket_IN',
        requestId: msg.params.requestId,
        payloadPreview: payload.substring(0, 500),
        payloadLength: payload.length,
      });
      
      // Log WS messages that look like friend/contact data
      if (payload.includes('friend') || payload.includes('contact') || payload.includes('displayName') ||
          payload.includes('member') || payload.includes('phoneNumber') || payload.includes('group')) {
        console.log(`[WS IN] (${payload.length} chars) ${payload.substring(0, 200)}`);
      }
    }
  }
  
  if (msg.method === 'Network.webSocketFrameSent') {
    const payload = msg.params.response?.payloadData || '';
    if (payload.length > 20) {
      capturedRequests.push({
        timestamp: new Date().toISOString(),
        type: 'WebSocket_OUT',
        requestId: msg.params.requestId,
        payloadPreview: payload.substring(0, 500),
        payloadLength: payload.length,
      });
    }
  }
});

ws.on('error', (err) => {
  console.error('[CDP] Error:', err.message);
});

ws.on('close', () => {
  console.log('[CDP] Connection closed');
  saveResults();
});

// Save on Ctrl+C
process.on('SIGINT', () => {
  console.log('\n[CDP] Stopping capture...');
  saveResults();
  process.exit(0);
});

function saveResults() {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const outFile = path.join(artifactsDir, 'zalo-api-capture.json');
  fs.writeFileSync(outFile, JSON.stringify(capturedRequests, null, 2));
  console.log(`[CDP] Saved ${capturedRequests.length} entries to ${outFile}`);
  
  // Also save a summary of unique API URLs
  const apiUrls = capturedRequests
    .filter(r => r.url && !r._responseBody)
    .map(r => `${r.method} ${r.url}`)
    .filter((v, i, a) => a.indexOf(v) === i);
  
  const summaryFile = path.join(artifactsDir, 'zalo-api-summary.txt');
  fs.writeFileSync(summaryFile, apiUrls.join('\n'));
  console.log(`[CDP] Saved ${apiUrls.length} unique URLs to ${summaryFile}`);
}

// Auto-save every 30 seconds
setInterval(saveResults, 30000);
