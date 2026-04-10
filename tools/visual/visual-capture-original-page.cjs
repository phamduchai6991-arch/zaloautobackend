const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const screenshotsDir = path.resolve(__dirname, '../../artifacts/screenshots');

(async () => {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  // Take fresh screenshot of original at same viewport 
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const page = contexts[0].pages().find(p => p.url().includes('zalotool'));
  if (!page) { console.log('No zalotool page found'); process.exit(1); }
  
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(screenshotsDir, 'reach-original-v3.png'), fullPage: true });
  console.log('Original screenshot saved');
  await browser.close();
})();
