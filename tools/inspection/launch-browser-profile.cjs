const { chromium } = require('playwright');
const path = require('path');

const profileDir = path.resolve(__dirname, '../../profiles/browser-data');

(async () => {
  // Launch browser with persistent context - saves cookies/session
  const context = await chromium.launchPersistentContext(
    profileDir,
    {
      headless: false,
      viewport: { width: 1400, height: 900 },
      args: ['--start-maximized'],
    }
  );

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://zalotool.net/reach');

  console.log('=== BROWSER OPENED ===');
  console.log('Please log in manually. After login, type "done" here and press Enter.');
  console.log('The browser will stay open for inspection.');
  console.log('=======================');

  // Keep the browser open - wait for user input
  process.stdin.resume();
  process.stdin.on('data', (data) => {
    const input = data.toString().trim();
    if (input === 'exit' || input === 'quit') {
      console.log('Closing browser...');
      context.close().then(() => process.exit(0));
    }
  });
})();
