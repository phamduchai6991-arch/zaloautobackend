const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const screenshotsDir = path.resolve(__dirname, '../../artifacts/screenshots');

(async () => {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  // Screenshot our clone
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://localhost:3001/reach', { waitUntil: 'networkidle', timeout: 10000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(screenshotsDir, 'reach-final-clone.png'), fullPage: true });
  console.log('Clone screenshot saved');
  await browser.close();

  // Screenshot original
  const browser2 = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser2.contexts();
  const origPage = contexts[0].pages().find(p => p.url().includes('zalotool'));
  if (origPage) {
    await origPage.setViewportSize({ width: 1440, height: 900 });
    await origPage.waitForTimeout(500);
    await origPage.screenshot({ path: path.join(screenshotsDir, 'reach-final-original.png'), fullPage: true });
    console.log('Original screenshot saved');
  }
  await browser2.close();
})();
