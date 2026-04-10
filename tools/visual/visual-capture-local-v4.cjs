const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const screenshotsDir = path.resolve(__dirname, '../../artifacts/screenshots');

(async () => {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://localhost:3001/reach', { waitUntil: 'networkidle', timeout: 10000 });
  await page.waitForTimeout(1500);
  const screenshotPath = path.join(screenshotsDir, 'reach-local-v4.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`Screenshot saved: ${screenshotPath}`);
  await browser.close();
})();
