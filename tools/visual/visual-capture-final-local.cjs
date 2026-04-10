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

    let ourPage = pages.find(p => p.url().includes('localhost:3000'));
    if (!ourPage) { 
      ourPage = await context.newPage();
    }
    await ourPage.goto('http://localhost:3000/reach', { waitUntil: 'networkidle', timeout: 10000 });
    await ourPage.setViewportSize({ width: 1400, height: 900 });
    
    // Small delay then screenshot
    await new Promise(r => setTimeout(r, 1000));
    const screenshotPath = path.join(screenshotsDir, 'reach-final-local.png');
    await ourPage.screenshot({ path: screenshotPath, fullPage: false, timeout: 10000 });
    console.log(`Screenshot saved: ${screenshotPath}`);
  } catch (e) {
    console.error('Error:', e.message);
  }
})();
