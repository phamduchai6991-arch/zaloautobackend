const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const screenshotsDir = path.resolve(__dirname, '../../artifacts/screenshots');

(async () => {
  try {
    fs.mkdirSync(screenshotsDir, { recursive: true });
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const context = browser.contexts()[0];
    const pages = context.pages();
    
    let page = pages.find(p => p.url().includes('localhost:3000'));
    if (!page) page = await context.newPage();
    
    await page.goto('http://localhost:3000/reach', { waitUntil: 'networkidle' });
    await page.setViewportSize({ width: 1400, height: 900 });
    const screenshotPath = path.join(screenshotsDir, 'reach-local-cdp-full.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`Screenshot saved as ${screenshotPath}`);
  } catch (e) {
    console.error('Error:', e.message);
  }
})();
