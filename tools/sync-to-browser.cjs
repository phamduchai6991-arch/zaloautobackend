/**
 * sync-to-browser.cjs
 * Copy extension source → Chrome's loaded extension folder, then reload.
 *
 * Usage:
 *   node tools/sync-to-browser.cjs                  # copy only
 *   node tools/sync-to-browser.cjs --reload          # copy + reload extension
 *   node tools/sync-to-browser.cjs --reload --reload-tab  # copy + reload ext + reload Zalo tab
 *
 * The browser extension folder is detected automatically via chrome-ext-profile/Default/Extensions.
 * Fallback: set EXT_DEST env var to the absolute path.
 */

const fs = require('fs');
const path = require('path');

const EXT_ID = 'idhfehmjlikfkddkehkolhppmekepanm';
const SRC_DIR = path.join(__dirname, '..', 'extension');
const DEST_FALLBACK = path.join(
  'C:', 'Users', process.env.USERNAME || 'Admin', 'Downloads', 'autozalo-extension (27)'
);

const args = process.argv.slice(2);
const doReload = args.includes('--reload');
const doReloadTab = args.includes('--reload-tab');

// ---- Find dest folder ----
function findExtDest() {
  if (process.env.EXT_DEST) return process.env.EXT_DEST;

  // Try chrome-ext-profile extensions folder
  const profileBase = path.join(__dirname, '..', '..', 'profiles', 'chrome-ext-profile', 'Default', 'Extensions', EXT_ID);
  if (fs.existsSync(profileBase)) {
    const versions = fs.readdirSync(profileBase).filter(v => fs.statSync(path.join(profileBase, v)).isDirectory());
    if (versions.length > 0) {
      versions.sort().reverse();
      return path.join(profileBase, versions[0]);
    }
  }

  // Fallback to Downloads
  return DEST_FALLBACK;
}

// ---- Copy files ----
function copyDir(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    if (fs.statSync(srcPath).isDirectory()) {
      count += copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

const dest = findExtDest();
const count = copyDir(SRC_DIR, dest);
console.log(`[sync] ${count} files → ${dest}`);

if (!doReload) process.exit(0);

// ---- Reload extension via CDP ----
const WebSocket = require('ws');

async function findZaloTab() {
  const http = require('http');
  return new Promise((resolve, reject) => {
    http.get('http://localhost:9222/json', (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const tabs = JSON.parse(data);
          const ext = tabs.find(t => t.url && t.url.includes('chrome://extensions'));
          const zalo = tabs.find(t => t.url && t.url.includes('chat.zalo.me'));
          resolve({ ext, zalo, tabs });
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

(async () => {
  try {
    const { ext, zalo } = await findZaloTab();

    // Reload extension via extensions page
    if (ext) {
      const ws = new WebSocket(`ws://localhost:9222/devtools/page/${ext.id}`);
      await new Promise((resolve, reject) => {
        ws.on('open', () => {
          const code = `chrome.developerPrivate.reload('${EXT_ID}', {failQuietly: true})`;
          ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: code } }));
        });
        ws.on('message', () => { ws.close(); resolve(); });
        ws.on('error', reject);
        setTimeout(resolve, 3000);
      });
      console.log('[sync] Extension reloaded');
    } else {
      console.warn('[sync] Extensions page not found — open chrome://extensions/ first');
    }

    // Reload Zalo tab if requested
    if (doReloadTab && zalo) {
      await new Promise(r => setTimeout(r, 1500)); // wait for ext reload
      const ws2 = new WebSocket(`ws://localhost:9222/devtools/page/${zalo.id}`);
      await new Promise((resolve, reject) => {
        ws2.on('open', () => ws2.send(JSON.stringify({ id: 1, method: 'Page.reload' })));
        ws2.on('message', () => { ws2.close(); resolve(); });
        ws2.on('error', reject);
        setTimeout(resolve, 3000);
      });
      console.log('[sync] Zalo tab reloaded');
    }
  } catch (e) {
    console.error('[sync] Error:', e.message);
    process.exit(1);
  }
})();
