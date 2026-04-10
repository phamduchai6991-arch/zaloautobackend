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
    
    // Find or create a page for our local dev
    let page = pages.find(p => p.url().includes('localhost:3000'));
    if (!page) {
      page = await context.newPage();
    }
    await page.goto('http://localhost:3000/reach', { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(screenshotsDir, 'reach-local-page-full.png'), fullPage: true });
    
    const text = await page.evaluate(() => document.body.innerText);
    console.log('=== PAGE TEXT ===');
    console.log(text.substring(0, 2000));
    
    console.log('\n=== DONE ===');
  } catch (e) {
    console.error('Error:', e.message);
  }
})();
