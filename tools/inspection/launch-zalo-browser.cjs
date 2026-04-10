/**
 * Launch a persistent Chrome browser aimed at chat.zalo.me
 * with remote debugging enabled so we can inspect APIs, cookies,
 * DOM structure and learn how Zalo actions work.
 *
 * Usage: node tools/inspection/launch-zalo-browser.cjs
 *
 * After the browser opens, log in to Zalo manually.
 * Then type "ready" to print session info, or "exit" to close.
 */
const { chromium } = require('playwright');
const path = require('path');

const profileDir = path.resolve(__dirname, '../../profiles/zalo-session');

(async () => {
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: [
      '--start-maximized',
      '--remote-debugging-port=9222',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://chat.zalo.me');

  console.log('============================================');
  console.log('  Chrome opened → https://chat.zalo.me');
  console.log('  Remote debugging on port 9222');
  console.log('');
  console.log('  Commands:');
  console.log('    ready  — print cookies & session info');
  console.log('    exit   — close browser');
  console.log('============================================');

  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (data) => {
    const cmd = data.toString().trim().toLowerCase();

    if (cmd === 'ready') {
      try {
        // Dump cookies
        const cookies = await context.cookies('https://chat.zalo.me');
        console.log(`\n=== ${cookies.length} cookies for chat.zalo.me ===`);
        cookies.forEach(c => {
          console.log(`  ${c.name} = ${c.value.substring(0, 40)}... (domain=${c.domain}, httpOnly=${c.httpOnly}, secure=${c.secure})`);
        });

        // Check logged-in state
        const loggedIn = await page.evaluate(() => {
          return {
            url: location.href,
            hasAfmc: typeof window.$$afmc !== 'undefined',
            hasZStorage: !!(window.$$afmc && window.$$afmc.zStorage),
            title: document.title,
          };
        });
        console.log('\n=== Session state ===');
        console.log(JSON.stringify(loggedIn, null, 2));

        if (loggedIn.hasZStorage) {
          const methods = await page.evaluate(() => {
            const zs = window.$$afmc.zStorage;
            const proto = Object.getPrototypeOf(zs);
            return Object.getOwnPropertyNames(proto)
              .filter(k => typeof proto[k] === 'function')
              .sort();
          });
          console.log(`\n=== zStorage methods (${methods.length}) ===`);
          console.log(methods.join(', '));
        }
      } catch (e) {
        console.error('Error:', e.message);
      }
    } else if (cmd === 'exit' || cmd === 'quit') {
      console.log('Closing browser...');
      await context.close();
      process.exit(0);
    }
  });
})();
