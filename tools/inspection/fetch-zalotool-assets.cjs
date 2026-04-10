const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const publicDir = path.resolve(__dirname, '../../public');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const page = contexts[0].pages().find(p => p.url().includes('zalotool'));
  if (!page) { console.log('No zalotool page found'); process.exit(1); }

  // Download the empty content SVG
  const svgContent = await page.evaluate(async () => {
    const resp = await fetch('https://zalotool.net/assets/illustrations/illustration_empty_content.svg');
    return resp.text();
  });

  if (svgContent) {
    fs.writeFileSync(path.join(publicDir, 'illustration_empty_content.svg'), svgContent, 'utf8');
    console.log('Empty content SVG saved! Length:', svgContent.length);
  }
  
  // Also get the flag icon
  const flagSvg = await page.evaluate(async () => {
    const resp = await fetch('https://zalotool.net/assets/icons/flags/ic_flag_vn.svg');
    return resp.text();
  });
  if (flagSvg) {
    fs.writeFileSync(path.join(publicDir, 'ic_flag_vn.svg'), flagSvg, 'utf8');
    console.log('Flag SVG saved! Length:', flagSvg.length);
  }

  await browser.close();
})();
